const { getConnection } = require('../config/database');
const moment = require('moment');
const PDFDocument = require('pdfkit');
const getStream = require('get-stream');
const fs = require('fs');
const path = require('path');

const fetchEmployees = async (pool, employeeId) => {
  let query = `SELECT userid, first_name ,
middle_name ,last_name FROM d00_emptable`;
  if (employeeId) query += ` WHERE userid = '${employeeId}'`;
  const result = await pool.request().query(query);
  return result.recordset;
};


const handleMonthlyReport = async (req, res) => {
  try {
    const pool = await getConnection();
    const { fromDate, toDate, employeeId, mode, type } = req.body;

    // Generate date range and mapping
    const start = moment(fromDate);
    const end = moment(toDate);
    const days = [];
    const dateMap = {};
    let dayIndex = 1;

    while (start <= end) {
      const dateStr = start.format('YYYY-MM-DD');
      const label = `attDate${dayIndex}`;
      days.push(label);
      dateMap[label] = dateStr;
      start.add(1, 'day');
      dayIndex++;
    }

    const employees = await fetchEmployees(pool, employeeId);

    // Fetch attendance data
    let attendanceData = [];
    if (mode === 'withtime') {
      const result = await pool.request()
        .input('fromDate', fromDate)
        .input('toDate', toDate)
        .query(`
          SELECT 
            e.userid, 
            ua_summary.AttDate,
            ua_summary.FirstInTime,
            ua_summary.LastOutTime,
            ua_summary.LastPunch
          FROM d00_emptable e
          INNER JOIN (
            SELECT 
              UserID,
              CAST(AttDateTime AS DATE) AS AttDate,
              MIN(CASE WHEN io_mode = 0 THEN AttDateTime END) AS FirstInTime,
              MAX(CASE WHEN io_mode = 1 THEN AttDateTime END) AS LastOutTime,
              MAX(AttDateTime) AS LastPunch
            FROM UserAttendance
            WHERE CAST(AttDateTime AS DATE) BETWEEN @fromDate AND @toDate
            GROUP BY UserID, CAST(AttDateTime AS DATE)
          ) ua_summary ON e.userid = ua_summary.UserID
        `);
      attendanceData = result.recordset;
    } else {
      const result = await pool.request()
        .input('fromDate', fromDate)
        .input('toDate', toDate)
        .query(`
          SELECT UserID, AttDateTime, io_mode 
          FROM UserAttendance 
          WHERE CAST(AttDateTime AS DATE) BETWEEN @fromDate AND @toDate
        `);
      attendanceData = result.recordset;
    }

    // Fetch holidays
    const holidayQuery = await pool.request()
      .input('fromDate', fromDate)
      .input('toDate', toDate)
      .query(`
        SELECT Date 
        FROM holiDaySchedule 
        WHERE CAST(Date AS DATE) BETWEEN @fromDate AND @toDate 
          AND IsActive = 1
      `);
    const holidays = holidayQuery.recordset.map(h => moment(h.Date).format('YYYY-MM-DD'));

    // Prepare attendance map
    const attMap = {};
    attendanceData.forEach(row => {
      const date = moment.utc(row.AttDateTime || row.AttDate).format('YYYY-MM-DD');
      const key = `${row.UserID || row.userid}_${date}`;
      attMap[key] = mode === 'withtime' ? {
        FirstInTime: row.FirstInTime ? moment(row.FirstInTime).format('HH:mm') : '',
        LastOutTime: row.LastOutTime ? moment(row.LastOutTime).format('HH:mm') : '',
        LastPunch: row.LastPunch ? moment(row.LastPunch).format('HH:mm') : ''
      } : 'P';
    });

    // Build report result
    const reportData = employees.map(emp => {
      const fullName = [emp.first_name, emp.middle_name, emp.last_name].filter(Boolean).join(' ');
      const row = { userid: emp.userid, username: fullName };

      days.forEach(label => {
        const date = dateMap[label];
        const key = `${emp.userid}_${date}`;
        const dayOfWeek = moment(date).day();

        if (dayOfWeek === 0) {
          row[label] = 'S'; // Sunday
        } else if (holidays.includes(date)) {
          row[label] = 'H'; // Holiday
        } else if (attMap[key]) {
          row[label] = mode === 'withtime' ? attMap[key] : 'P';
        } else {
          row[label] = 'A'; // Absent
        }
      });

      return row;
    });

    if (type === 'pdf') {
      const doc = new PDFDocument({ margin: 20, size: 'A4', layout: 'landscape' });

const usablePageWidth = 595.28 - 40; // A4 width - margins
const fixedLeftWidth = 150; // UserID (50) + Name (100)
const dynamicWidth = usablePageWidth - fixedLeftWidth;

const dayCount = days.length;
const colWidth = Math.floor(dynamicWidth / dayCount)+8;

const fileName = `Monthly_Attendance_Report.pdf`;
const filePath = path.join(__dirname, fileName);
const stream = fs.createWriteStream(filePath);

doc.pipe(stream);

// Title
doc.fillColor('#0A5275').fontSize(16).font('Helvetica-Bold').text('Monthly Attendance Report', { align: 'center' });
doc.moveDown(0.3);
doc.fillColor('black').fontSize(10).text(`From: ${fromDate} To: ${toDate}`, { align: 'center' });
doc.moveDown(1);

// Table headers
let x = 20;
let y = doc.y;

doc.font('Helvetica-Bold').fontSize(8);

// Draw UserID
doc.rect(x, y, 30, 25).fillAndStroke('#D6EAF8', '#000').fillColor('black');
doc.text('UserID', x + 2, y + 6);
x += 30;

// Draw Name
doc.rect(x, y, 80, 25).fillAndStroke('#D6EAF8', '#000').fillColor('black');
doc.text('Name', x + 5, y + 6);
x += 80;

// Draw day columns
days.forEach((day, i) => {
  const dayNum = i + 1;
  const dayText = `${dayNum}`;

  // Draw a filled rectangle for the header cell (background color)
  doc.rect(x, y, colWidth, 25).fillAndStroke('#AED6F1', '#000').fillColor('black');

  // Adjust text positioning based on column width
  if (colWidth < 18) {
    console.log("Column Width Too Small");
    doc.save();
    // If the column is too narrow, left-align the text
    doc.text(dayText, x + 6, y + 20, { width: 20, align: 'left' });
    doc.restore();
  } else {
    // If the column is wide enough, center-align the text
    doc.text(dayText, x + 2, y + 6, { width: colWidth - 4, align: 'center' });
  }

  // Move x position to the next column
  x += colWidth;
});



// Table body
y += 25;

reportData.forEach(emp => {
  x = 20;
  if (y > 750) {
    doc.addPage({ layout: 'portrait' });
    y = 30;
  }

  doc.fillColor('black').font('Helvetica').fontSize(6);

  // UserID
  doc.rect(x, y, 30, 20).stroke();
  doc.text(emp.userid.toString(), x + 2, y + 4, { width: 48, align: 'left' });
  x += 30;

  // Name
  doc.rect(x, y, 80, 20).stroke();
  doc.text(emp.username, x + 2, y + 4, { width: 98, align: 'left' });
  x += 80;

  // Days data
  days.forEach((day, i) => {
    const value = emp[day];
    let display = '';

    if (mode === 'withtime' && typeof value === 'object') {
      const inTime = value.FirstInTime || '--';
      const outTime = value.LastOutTime || '--';
      display = `${inTime}-${outTime}`;
    } else {
      display = value || '-';
    }

    doc.rect(x, y, colWidth, 20).stroke();
    doc.text(display, x + 1, y + 4, { width: colWidth - 2, align: 'center' });
    x += colWidth;
  });

  y += 20;
});

doc.end();
      stream.on('finish', () => {
        console.log(`✅ PDF saved locally at: ${filePath}`);
        res.status(200).json({
          isSuccess: true,
          message: 'PDF saved locally',
          path: filePath,
        });
      });
    
      stream.on('error', (err) => {
        console.error('❌ Error writing PDF:', err);
        res.status(500).json({ isSuccess: false, message: 'Error saving PDF' });
      });
    }
 else {
      res.status(200).json({
        isSuccess: true,
        message: 'Monthly report fetched successfully',
        data: reportData
      });
    }
  } catch (error) {
    res.status(500).json({
      isSuccess: false,
      message: `Error in fetching monthly report: ${error.message}`,
      data: []
    });
  }
};


const handleDailyReport = async (req, res) => {
  try {
    const pool = await getConnection();
    const { date, employeeId } = req.body;

    // Default to today's date if no date is provided
    const day = moment(date || new Date()).format('YYYY-MM-DD');

    // 1. Fetch Employees
    const employeesQuery = `
      SELECT userid, 
             CONCAT(first_name, ' ', ISNULL(middle_name, ''), ' ', last_name) AS empname 
      FROM d00_emptable
      ${employeeId && employeeId !== -1 ? `WHERE userid = '${employeeId}'` : ''}
    `;
    const employees = (await pool.request().query(employeesQuery)).recordset;

    // 2. Fetch Attendance with In/Out Time
    const attendanceQuery = `
      SELECT 
        ua.UserID, 
        MIN(CASE WHEN ua.io_mode = 0 THEN CONVERT(VARCHAR, ua.AttDateTime, 108) END) AS FirstInTime,
        MAX(CASE WHEN ua.io_mode = 1 THEN CONVERT(VARCHAR, ua.AttDateTime, 108) END) AS LastOutTime
      FROM UserAttendance ua
      WHERE CAST(ua.AttDateTime AS DATE) = '${day}'
      GROUP BY ua.UserID
    `;
    const attendanceData = (await pool.request().query(attendanceQuery)).recordset;

    const attendanceMap = {};
    attendanceData.forEach(row => {
      attendanceMap[row.UserID] = {
        inTime: row.FirstInTime,
        outTime: row.LastOutTime
      };
    });

    // 3. Check for Holiday
    const holidayQuery = `
      SELECT Date 
      FROM holiDaySchedule 
      WHERE Date = '${day}' AND IsActive = 1
    `;
    const isHoliday = (await pool.request().query(holidayQuery)).recordset.length > 0;
    const isSunday = moment(day).day() === 0;

    // 4. Generate the days array for the report (only one day in this case)
    const days = [day]; // If you want a range, you can modify this part

    // 5. Prepare the result array to store the report data
    const result = [];

    // 6. Combine Data and Prepare Report
    employees.forEach(emp => {
      const att = attendanceMap[emp.userid];
      let status = 'A'; // Default to Absent
      let workingHours = null;

      // If employee has both FirstInTime and LastOutTime, calculate working hours
      if (att?.inTime && att?.outTime) {
        const inTime = moment(att.inTime, 'HH:mm:ss');
        const outTime = moment(att.outTime, 'HH:mm:ss');
        const duration = moment.duration(outTime.diff(inTime)); // Get the difference
        workingHours = `${duration.hours()}h ${duration.minutes()}m`; // Format it
      }

      // Iterate through each day (only one day in this case)
      days.forEach(d => {
        const key = `${emp.userid}_${d}`;
        const dayOfWeek = moment(d).day();

        if (dayOfWeek === 0) {
          status = 'S'; // Sunday
        } else if (isHoliday) {
          status = 'H'; // Holiday
        } else if (att) {
          status = 'P'; // Present (or adjust as needed)
        }

        // Populate result with the report data (including working hours)
        result.push({
          userid: emp.userid,
          empname: emp.empname.trim().replace(/\s+/g, ' '),
          date: d,
          status,
          FirstInTime: att?.inTime || null,
          LastOutTime: att?.outTime || null,
          workingHours // Add working hours as a separate parameter
        });
      });
    });

    res.status(200).json({
      isSuccess: true,
      message: 'Daily report with In/Out time and working hours fetched successfully',
      data: result
    });
  } catch (error) {
    console.error('Daily Report Error:', error.message);
    res.status(500).json({
      isSuccess: false,
      message: `Error in fetching daily report: ${error.message}`,
      data: []
    });
  }
};


const handlePunchReport = async (req, res) => {
  try {
    const pool = await getConnection();
    const { fromDate, toDate, employeeId } = req.body;

    const start = moment(fromDate || new Date()).startOf('day');
    const end = moment(toDate || new Date()).endOf('day');

    // Generate list of all dates in the range
    const days = [];
    for (let m = moment(start); m.isSameOrBefore(end); m.add(1, 'days')) {
      days.push(m.format('YYYY-MM-DD'));
    }
    // 1. Fetch Employees
    const employeesQuery = `
      SELECT userid, 
             CONCAT(first_name, ' ', ISNULL(middle_name, ''), ' ', last_name) AS empname 
      FROM d00_emptable
      ${employeeId && employeeId !== -1 ? `WHERE userid = '${employeeId}'` : ''}
    `;
    const employees = (await pool.request().query(employeesQuery)).recordset;

    // 2. Fetch Attendance for the range
    const attendanceQuery = `
      SELECT 
        ua.UserID, 
        CAST(ua.AttDateTime AS DATE) AS AttDate,
        MIN(CASE WHEN ua.io_mode = 0 THEN CONVERT(VARCHAR, ua.AttDateTime, 108) END) AS FirstInTime,
        MAX(CASE WHEN ua.io_mode = 1 THEN CONVERT(VARCHAR, ua.AttDateTime, 108) END) AS LastOutTime
      FROM UserAttendance ua
      WHERE ua.AttDateTime BETWEEN '${start.format('YYYY-MM-DD')}' AND '${end.format('YYYY-MM-DD')} 23:59:59'
      GROUP BY ua.UserID, CAST(ua.AttDateTime AS DATE)
    `;
    const attendanceData = (await pool.request().query(attendanceQuery)).recordset;

    // Map attendance per user per date
    const attendanceMap = {};
    attendanceData.forEach(row => {
      const key = `${row.UserID}_${moment(row.AttDate).format('YYYY-MM-DD')}`;
      attendanceMap[key] = {
        inTime: row.FirstInTime,
        outTime: row.LastOutTime
      };
    });

    // 3. Fetch Holidays in the range
    const holidayQuery = `
      SELECT Date 
      FROM holiDaySchedule 
      WHERE Date BETWEEN '${start.format('YYYY-MM-DD')}' AND '${end.format('YYYY-MM-DD')}'
        AND IsActive = 1
    `;
    const holidayDates = new Set(
      (await pool.request().query(holidayQuery)).recordset.map(h => moment(h.Date).format('YYYY-MM-DD'))
    );

    // 4. Prepare the result
    const result = [];

    employees.forEach(emp => {
      days.forEach(day => {
        const key = `${emp.userid}_${day}`;
        const att = attendanceMap[key];
        const dayOfWeek = moment(day).day();

        let status = 'A'; // Default to Absent
        let workingHours = null;

        if (dayOfWeek === 0) {
          status = 'S'; // Sunday
        } else if (holidayDates.has(day)) {
          status = 'H'; // Holiday
        } else if (att) {
          status = 'P'; // Present

          if (att.inTime && att.outTime) {
            const inTime = moment(att.inTime, 'HH:mm:ss');
            const outTime = moment(att.outTime, 'HH:mm:ss');
            const duration = moment.duration(outTime.diff(inTime));
            workingHours = `${duration.hours()}h ${duration.minutes()}m`;
          }
        }

        result.push({
          userid: emp.userid,
          empname: emp.empname.trim().replace(/\s+/g, ' '),
          date: day,
          status,
          FirstInTime: att?.inTime || null,
          LastOutTime: att?.outTime || null,
          workingHours
        });
      });
    });

    res.status(200).json({
      isSuccess: true,
      message: 'Report fetched successfully for date range',
      data: result
    });
  } catch (error) {
    console.error('Punch Report Error:', error.message);
    res.status(500).json({
      isSuccess: false,
      message: `Error generating report: ${error.message}`,
      data: []
    });
  }
};


// const handlePunchReport = async (req, res) => {
//   try {
//     const pool = await getConnection();
//     const { date, employeeId } = req.body;

//     // Default to today's date if no date is provided
//     const day = moment(date || new Date()).format('YYYY-MM-DD');

//     // 1. Fetch Employees
//     const employeesQuery = `
//       SELECT userid, 
//              CONCAT(first_name, ' ', ISNULL(middle_name, ''), ' ', last_name) AS empname 
//       FROM d00_emptable
//       ${employeeId && employeeId !== -1 ? `WHERE userid = '${employeeId}'` : ''}
//     `;
//     const employees = (await pool.request().query(employeesQuery)).recordset;

//     // 2. Fetch Attendance with In/Out Time
//     const attendanceQuery = `
//       SELECT 
//         ua.UserID, 
//         MIN(CASE WHEN ua.io_mode = 0 THEN CONVERT(VARCHAR, ua.AttDateTime, 108) END) AS FirstInTime,
//         MAX(CASE WHEN ua.io_mode = 1 THEN CONVERT(VARCHAR, ua.AttDateTime, 108) END) AS LastOutTime
//       FROM UserAttendance ua
//       WHERE CAST(ua.AttDateTime AS DATE) = '${day}'
//       GROUP BY ua.UserID
//     `;
//     const attendanceData = (await pool.request().query(attendanceQuery)).recordset;

//     const attendanceMap = {};
//     attendanceData.forEach(row => {
//       attendanceMap[row.UserID] = {
//         inTime: row.FirstInTime,
//         outTime: row.LastOutTime
//       };
//     });

//     // 3. Check for Holiday
//     const holidayQuery = `
//       SELECT Date 
//       FROM holiDaySchedule 
//       WHERE Date = '${day}' AND IsActive = 1
//     `;
//     const isHoliday = (await pool.request().query(holidayQuery)).recordset.length > 0;
//     const isSunday = moment(day).day() === 0;

//     // 4. Generate the days array for the report (only one day in this case)
//     const days = [day]; // If you want a range, you can modify this part

//     // 5. Prepare the result array to store the report data
//     const result = [];

//     // 6. Combine Data and Prepare Report
//     employees.forEach(emp => {
//       const att = attendanceMap[emp.userid];
//       let status = 'A'; // Default to Absent
//       let workingHours = null;

//       // If employee has both FirstInTime and LastOutTime, calculate working hours
//       if (att?.inTime && att?.outTime) {
//         const inTime = moment(att.inTime, 'HH:mm:ss');
//         const outTime = moment(att.outTime, 'HH:mm:ss');
//         const duration = moment.duration(outTime.diff(inTime)); // Get the difference
//         workingHours = `${duration.hours()}h ${duration.minutes()}m`; // Format it
//       }

//       // Iterate through each day (only one day in this case)
//       days.forEach(d => {
//         const key = `${emp.userid}_${d}`;
//         const dayOfWeek = moment(d).day();

//         if (dayOfWeek === 0) {
//           status = 'S'; // Sunday
//         } else if (isHoliday) {
//           status = 'H'; // Holiday
//         } else if (att) {
//           status = 'P'; // Present (or adjust as needed)
//         }

//         // Populate result with the report data (including working hours)
//         result.push({
//           userid: emp.userid,
//           empname: emp.empname.trim().replace(/\s+/g, ' '),
//           date: d,
//           status,
//           FirstInTime: att?.inTime || null,
//           LastOutTime: att?.outTime || null,
//           workingHours // Add working hours as a separate parameter
//         });
//       });
//     });

//     res.status(200).json({
//       isSuccess: true,
//       message: 'Daily report with In/Out time and working hours fetched successfully',
//       data: result
//     });
//   } catch (error) {
//     console.error('Daily Report Error:', error.message);
//     res.status(500).json({
//       isSuccess: false,
//       message: `Error in fetching daily report: ${error.message}`,
//       data: []
//     });
//   }
// };














module.exports = {
  handlePunchReport,
  handleDailyReport,
  handleMonthlyReport
};
