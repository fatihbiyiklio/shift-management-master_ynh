const express = require('express');
const session = require('express-session');
const bodyParser = require('body-parser');
const fs = require('fs');
const path = require('path');
const bcrypt = require('bcryptjs');
const rateLimit = require('express-rate-limit');
const ExcelJS = require('exceljs');

// Cache nesneleri
let usersCache = null;
let employeesCache = null;
let shiftsCache = null;
let lastCacheUpdate = {
    users: 0,
    employees: 0,
    shifts: 0
};

const CACHE_DURATION = 5 * 60 * 1000; // 5 dakika

const app = express();
const port = 3000;

// Rate limiting
const limiter = rateLimit({
    windowMs: 15 * 60 * 1000, // 15 dakika
    max: 100 // IP başına maksimum istek
});

app.use(limiter);
app.use(bodyParser.urlencoded({ extended: true }));
app.use(bodyParser.json());
app.use(express.static('public', {
    maxAge: '1h' // Static dosyalar için client-side cache
}));
app.set('view engine', 'ejs');

// Session configuration
app.use(session({
    secret: process.env.SESSION_SECRET || 'your-secret-key',
    resave: false,
    saveUninitialized: false,
    cookie: {
        secure: process.env.NODE_ENV === 'production',
        httpOnly: true,
        maxAge: 24 * 60 * 60 * 1000 // 24 saat
    }
}));

// Veri yönetimi fonksiyonları
function loadData(type) {
    const file = path.join(__dirname, 'data', `${type}.json`);
    const now = Date.now();
    
    if (global[`${type}Cache`] && (now - lastCacheUpdate[type] < CACHE_DURATION)) {
        return global[`${type}Cache`];
    }

    try {
        const data = JSON.parse(fs.readFileSync(file));
        global[`${type}Cache`] = data;
        lastCacheUpdate[type] = now;
        return data;
    } catch (error) {
        console.error(`Error loading ${type} data:`, error);
        return null;
    }
}

function saveData(type, data) {
    const file = path.join(__dirname, 'data', `${type}.json`);
    try {
        fs.writeFileSync(file, JSON.stringify(data, null, 2));
        global[`${type}Cache`] = data;
        lastCacheUpdate[type] = Date.now();
        return true;
    } catch (error) {
        console.error(`Error saving ${type} data:`, error);
        return false;
    }
}

// Authentication middleware
const requireAuth = (req, res, next) => {
    if (req.session.user) {
        next();
    } else {
        res.redirect('/login');
    }
};

// Routes
app.get('/', (req, res) => {
    res.redirect('/login');
});

app.get('/login', (req, res) => {
    if (req.session.user) {
        res.redirect('/dashboard');
    } else {
        res.render('login');
    }
});

app.post('/login', (req, res) => {
    const { username, password } = req.body;
    const users = loadData('users');
    const user = users.find(u => u.username === username);

    if (user && bcrypt.compareSync(password, user.password)) {
        req.session.user = { username: user.username, role: user.role };
        res.redirect('/dashboard');
    } else {
        res.render('login', { error: 'Invalid credentials' });
    }
});

app.get('/dashboard', requireAuth, (req, res) => {
    res.render('dashboard', { user: req.session.user });
});

app.get('/employees', requireAuth, (req, res) => {
    const employees = loadData('employees');
    res.render('employees', { employees });
});

app.post('/employees', requireAuth, (req, res) => {
    const employees = loadData('employees');
    const newEmployee = req.body;
    newEmployee.id = Date.now().toString();
    employees.push(newEmployee);
    saveData('employees', employees);
    res.redirect('/employees');
});

app.get('/shifts', requireAuth, (req, res) => {
    try {
        const shifts = loadData('shifts');
        const employees = loadData('employees');
        
        if (!shifts || !employees) {
            throw new Error('Veri yükleme hatası');
        }
        
        res.render('shifts', { 
            shifts, 
            employees,
            user: req.session.user 
        });
    } catch (error) {
        console.error('Shifts route error:', error);
        res.status(500).send('Sunucu hatası');
    }
});

// Excel export endpoint'i
app.get('/shifts/export', requireAuth, async (req, res) => {
    try {
        const { year, month } = req.query;
        if (!year || !month) {
            throw new Error('Yıl ve ay parametreleri gereklidir');
        }

        console.log('Export request for:', { year, month });
        
        const shifts = loadData('shifts');
        const employees = loadData('employees');

        if (!shifts || !employees) {
            console.error('Data loading error:', { shifts: !!shifts, employees: !!employees });
            throw new Error('Veri yükleme hatası');
        }

        console.log('Data loaded successfully');
        console.log('Shift Types:', shifts.shiftTypes);
        console.log('Total Assignments:', shifts.assignments.length);
        console.log('Total Employees:', employees.length);

        // Excel dosyası oluştur
        const workbook = new ExcelJS.Workbook();
        workbook.creator = 'Shift Management System';
        workbook.created = new Date();
        
        const worksheet = workbook.addWorksheet('Vardiya Tablosu', {
            pageSetup: {
                paperSize: 9,
                orientation: 'landscape'
            }
        });

        // Başlık stilini ayarla
        const headerStyle = {
            font: { bold: true, size: 12 },
            fill: {
                type: 'pattern',
                pattern: 'solid',
                fgColor: { argb: 'FFE0E0E0' }
            },
            alignment: { horizontal: 'center', vertical: 'middle' }
        };

        // Sütun başlıklarını ayarla
        worksheet.columns = [
            { header: 'Tarih', key: 'date', width: 15 },
            { header: 'Çalışan', key: 'employee', width: 20 },
            { header: 'Vardiya', key: 'shift', width: 15 },
            { header: 'Başlangıç', key: 'start', width: 12 },
            { header: 'Bitiş', key: 'end', width: 12 }
        ];

        // Başlık stilini uygula
        worksheet.getRow(1).eachCell(cell => {
            cell.style = headerStyle;
        });
        worksheet.getRow(1).height = 25;

        // Seçili ay için vardiyaları filtrele
        const monthStart = new Date(parseInt(year), parseInt(month) - 1, 1);
        const monthEnd = new Date(parseInt(year), parseInt(month), 0);

        console.log('Filtering assignments for:', {
            monthStart: monthStart.toISOString(),
            monthEnd: monthEnd.toISOString()
        });

        const filteredAssignments = shifts.assignments.filter(assignment => {
            const assignmentDate = new Date(assignment.date);
            return assignmentDate >= monthStart && assignmentDate <= monthEnd;
        });

        console.log('Filtered assignments:', filteredAssignments.length);

        if (filteredAssignments.length === 0) {
            throw new Error('Bu ay için vardiya kaydı bulunamadı');
        }

        // Vardiyaları sırala
        filteredAssignments.sort((a, b) => new Date(a.date) - new Date(b.date));

        // Verileri ekle
        filteredAssignments.forEach(assignment => {
            const employee = employees.find(e => e.id === assignment.employeeId);
            const shiftType = shifts.shiftTypes.find(s => s.id === parseInt(assignment.shiftTypeId));
            
            console.log('Processing assignment:', {
                employeeId: assignment.employeeId,
                shiftTypeId: assignment.shiftTypeId,
                foundEmployee: !!employee,
                foundShiftType: !!shiftType
            });

            if (employee && shiftType) {
                worksheet.addRow({
                    date: new Date(assignment.date).toLocaleDateString('tr-TR'),
                    employee: employee.fullName,
                    shift: shiftType.name,
                    start: shiftType.startTime,
                    end: shiftType.endTime
                });
            }
        });

        // Tablo stilini ayarla
        worksheet.eachRow((row, rowNumber) => {
            if (rowNumber > 1) { // Başlık satırını atla
                row.height = 20;
                row.eachCell(cell => {
                    cell.alignment = { horizontal: 'center', vertical: 'middle' };
                    cell.border = {
                        top: { style: 'thin' },
                        left: { style: 'thin' },
                        bottom: { style: 'thin' },
                        right: { style: 'thin' }
                    };
                });
            }
        });

        console.log('Excel file created, preparing to send...');

        // Excel dosyasını oluştur ve gönder
        res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
        res.setHeader('Content-Disposition', `attachment; filename=Vardiya_Tablosu_${year}_${month}.xlsx`);
        
        await workbook.xlsx.write(res);

        console.log('Excel file sent successfully');
    } catch (error) {
        console.error('Excel export detailed error:', error);
        res.status(400).json({ 
            error: 'Excel dosyası oluşturulamadı',
            details: error.message
        });
    }
});

app.post('/shifts/types', requireAuth, (req, res) => {
    const shifts = loadData('shifts');
    const newShiftType = {
        id: Date.now(),
        name: req.body.name,
        startTime: req.body.startTime,
        endTime: req.body.endTime
    };
    shifts.shiftTypes.push(newShiftType);
    saveData('shifts', shifts);
    res.redirect('/shifts');
});

app.post('/shifts/assignments', requireAuth, async (req, res) => {
    try {
        if (!req.body.employeeId || !req.body.shiftTypeId || !req.body.date) {
            return res.status(400).json({
                error: 'Eksik bilgi',
                message: 'Çalışan, vardiya tipi ve tarih bilgileri gereklidir'
            });
        }

        const shifts = loadData('shifts');
        
        // Yeni atama oluştur
        const newAssignment = {
            id: Date.now(),
            employeeId: req.body.employeeId,
            date: req.body.date,
            shiftTypeId: parseInt(req.body.shiftTypeId)
        };

        // Çakışma kontrolü
        const hasConflict = shifts.assignments.some(assignment => 
            assignment.employeeId === newAssignment.employeeId && 
            assignment.date === newAssignment.date
        );

        if (hasConflict) {
            return res.status(400).json({
                error: 'Çakışma',
                message: 'Bu çalışan için seçili tarihte zaten bir vardiya atanmış'
            });
        }

        // Yeni atamayı ekle
        shifts.assignments.push(newAssignment);
        
        // Dosyaya kaydet
        saveData('shifts', shifts);

        // Başarılı yanıt döndür
        return res.status(200).json({
            success: true,
            message: 'Vardiya başarıyla atandı',
            assignment: newAssignment
        });

    } catch (error) {
        console.error('Vardiya atama hatası:', error);
        return res.status(500).json({
            error: 'Sunucu hatası',
            message: 'Vardiya atanırken bir hata oluştu'
        });
    }
});

app.post('/delete-shift', requireAuth, (req, res) => {
    try {
        const { employeeId, date } = req.body;
        const shifts = loadData('shifts');
        
        shifts.assignments = shifts.assignments.filter(assignment => 
            !(assignment.employeeId === employeeId && assignment.date === date)
        );
        
        saveData('shifts', shifts);
        res.json({ success: true });
    } catch (error) {
        console.error('Vardiya silme hatası:', error);
        res.status(500).json({ error: 'Vardiya silinirken bir hata oluştu' });
    }
});

app.get('/logout', (req, res) => {
    req.session.destroy();
    res.redirect('/login');
});

app.listen(port, () => {
    console.log(`Server running at http://localhost:${port}`);
});