/**
 * GOOGLE APPS SCRIPT FOR UNIVERSAL TELECALLER CRM (SELF-HEALING AUTO-DETECT VERSION)
 * 
 * INSTRUCTIONS FOR SETTING UP GOOGLE SHEETS SYNC:
 * 
 * 1. Open your Google Sheet.
 * 2. Go to "Extensions" > "Apps Script".
 * 3. Delete any default code in the editor, and paste this entire script.
 * 4. Save (Ctrl+S) and deploy the script as a Web App:
 *    - Click "Deploy" > "New deployment"
 *    - Select type: "Web app" (gear icon)
 *    - Execute as: "Me"
 *    - Who has access: "Anyone" (This is crucial!)
 * 5. Click "Deploy". Authorize permissions if Google asks.
 * 6. Copy the "Web app URL" (ends in "/exec") and paste it in app.js as DEFAULT_SHEET_URL.
 */

function doPost(e) {
  try {
    var ss = SpreadsheetApp.getActiveSpreadsheet();
    if (!ss) {
      return ContentService.createTextOutput(JSON.stringify({
        status: "error",
        message: "Error: Standalone script detected. Please paste inside Extensions > Apps Script in your sheet."
      }))
      .setMimeType(ContentService.MimeType.JSON);
    }
    
    // Automatically find the sheet tab that contains the telecaller logs (Self-Healing)
    var sheet = findLogsSheet(ss);
    
    // Initialize headers if empty
    if (sheet.getLastRow() === 0) {
      sheet.appendRow([
        "Timestamp",
        "Customer Name",
        "Mobile Number",
        "Age",
        "Gender",
        "Call Status",
        "Appointment Given",
        "Appointment Date/Time",
        "BI Required",
        "BI Product Category",
        "Call Comments",
        "Added By",
        "Audio Note"
      ]);
      sheet.getRange(1, 1, 1, 13).setFontWeight("bold").setBackground("#4f46e5").setFontColor("#ffffff");
    }
    
    var data;
    if (e.postData && e.postData.contents) {
      try {
        data = JSON.parse(e.postData.contents);
      } catch (jsonError) {
        data = e.parameter;
      }
    } else {
      data = e.parameter;
    }
    
    // Connection test handler
    if (data && (data.isTest === true || data.isTest === "true")) {
      return ContentService.createTextOutput(JSON.stringify({
        status: "success",
        message: "Web App URL is configured correctly and online!"
      }))
      .setMimeType(ContentService.MimeType.JSON);
    }
    
    var timestamp = new Date();
    var name = data.name || "N/A";
    var mobile = data.mobile || "N/A";
    var age = data.age || "N/A";
    var gender = data.gender || "N/A";
    var status = data.status || "N/A";
    var appointmentGiven = data.appointmentGiven || "N/A";
    var appointmentDate = data.appointmentDate || "N/A";
    var biRequired = data.biRequired || "N/A";
    var biProduct = data.biProduct || "N/A";
    var comments = data.comments || "N/A";
    var addedBy = data.addedBy || "N/A";
    var audioRecording = data.audioRecording || "N/A";
    
    // --- DYNAMIC HEADER MAPPING ENGINE ---
    var range = sheet.getDataRange();
    var values = range.getValues();
    var headers = values[0];
    
    // Helper function to find column index with aliases
    function getColIdx(aliases, defaultIdx) {
      for (var a = 0; a < aliases.length; a++) {
        var idx = headers.indexOf(aliases[a]);
        if (idx !== -1) return idx;
      }
      return defaultIdx;
    }

    var colTimestamp = getColIdx(["Timestamp", "Time", "Date"], 0);
    var colName = getColIdx(["Customer Name", "Name", "Client Name"], 1);
    var colMobile = getColIdx(["Mobile Number", "Mobile", "Phone Number", "Phone", "Contact"], 2);
    var colAge = getColIdx(["Age"], 3);
    var colGender = getColIdx(["Gender", "Sex"], 4);
    var colStatus = getColIdx(["Call Status", "Status"], 5);
    var colApptGiven = getColIdx(["Appointment Given", "Appointment"], 6);
    var colApptDate = getColIdx(["Appointment Date/Time", "Appointment Date", "Appt Date"], 7);
    var colBiReq = getColIdx(["BI Required", "BI"], 8);
    var colBiProd = getColIdx(["BI Product Category", "BI Product", "Product"], 9);
    var colComments = getColIdx(["Call Comments", "Comments", "Remarks", "Remarks / Comments", "Notes"], 10);
    var colAddedBy = getColIdx(["Added By", "Agent", "Caller", "User", "Addedby"], 11);
    var colAudio = getColIdx(["Audio Note", "Audio Recording", "Recording", "Audio", "Voice Note"], 12);

    // Build dynamically ordered values array to preserve columns even if user rearranged them
    var rowValues = [];
    for (var k = 0; k < headers.length; k++) {
      rowValues.push("");
    }
    
    rowValues[colTimestamp] = timestamp;
    rowValues[colName] = name;
    rowValues[colMobile] = "'" + mobile; // Force text formatting
    rowValues[colAge] = age;
    rowValues[colGender] = gender;
    rowValues[colStatus] = status;
    rowValues[colApptGiven] = appointmentGiven;
    rowValues[colApptDate] = appointmentDate;
    rowValues[colBiReq] = biRequired;
    rowValues[colBiProd] = biProduct;
    rowValues[colComments] = comments;
    rowValues[colAddedBy] = addedBy;
    if (colAudio < rowValues.length) {
      rowValues[colAudio] = audioRecording;
    } else {
      rowValues.push(audioRecording);
    }

    // --- SMART OVERWRITE ENGINE (Edit In-place) ---
    var rowIndex = -1;
    var searchMobile = mobile ? mobile.toString().replace(/[^0-9]/g, "") : "";
    if (searchMobile.indexOf('.') !== -1) {
      searchMobile = searchMobile.split('.')[0];
    }
    
    if (searchMobile !== "") {
      for (var i = 1; i < values.length; i++) {
        var rowMobileRaw = values[i][colMobile];
        var rowMobile = rowMobileRaw ? rowMobileRaw.toString().replace(/[^0-9]/g, "") : "";
        if (rowMobile.indexOf('.') !== -1) {
          rowMobile = rowMobile.split('.')[0];
        }
        if (rowMobile === searchMobile) {
          rowIndex = i + 1; // 1-indexed matching row
          break;
        }
      }
    }
    
    if (rowIndex !== -1) {
      // Overwrite the existing client row in-place (Edit mode)
      sheet.getRange(rowIndex, 1, 1, headers.length).setValues([rowValues]);
      return ContentService.createTextOutput(JSON.stringify({
        status: "success",
        message: "Existing record successfully updated in Google Sheets!"
      }))
      .setMimeType(ContentService.MimeType.JSON);
    } else {
      // Append a brand new row (New submission)
      sheet.appendRow(rowValues);
      return ContentService.createTextOutput(JSON.stringify({
        status: "success",
        message: "New record successfully logged to Google Sheets!"
      }))
      .setMimeType(ContentService.MimeType.JSON);
    }
    
  } catch (error) {
    return ContentService.createTextOutput(JSON.stringify({
      status: "error",
      message: error.toString()
    }))
    .setMimeType(ContentService.MimeType.JSON);
  }
}

// Enable CORS preflight options requests (Standard bypass returning raw headers)
function doOptions(e) {
  var output = ContentService.createTextOutput("");
  return output.setMimeType(ContentService.MimeType.TEXT);
}

// --- 2-WAY TEAM SYNC ENGINE (Remote fetch) ---
function doGet(e) {
  try {
    var ss = SpreadsheetApp.getActiveSpreadsheet();
    if (!ss) {
      return ContentService.createTextOutput(JSON.stringify({
        status: "connected",
        message: "Standalone Google Apps Script online."
      }))
      .setMimeType(ContentService.MimeType.JSON);
    }
    
    // Automatically find the sheet tab that contains the telecaller logs (Self-Healing)
    var sheet = findLogsSheet(ss);
    
    // Check if the request is to pull data
    if (e && e.parameter && e.parameter.action === "fetch") {
      var lastRow = sheet.getLastRow();
      var dataList = [];
      
      if (lastRow > 0) {
        var range = sheet.getRange(1, 1, lastRow, sheet.getLastColumn() || 12);
        var values = range.getValues();
        var headers = values[0];
        
        // Helper function to find column index with fallback aliases
        function getColIdx(aliases, defaultIdx) {
          for (var a = 0; a < aliases.length; a++) {
            var idx = headers.indexOf(aliases[a]);
            if (idx !== -1) return idx;
          }
          return defaultIdx;
        }

        var colTimestamp = getColIdx(["Timestamp", "Time", "Date"], 0);
        var colName = getColIdx(["Customer Name", "Name", "Client Name"], 1);
        var colMobile = getColIdx(["Mobile Number", "Mobile", "Phone Number", "Phone", "Contact"], 2);
        var colAge = getColIdx(["Age"], 3);
        var colGender = getColIdx(["Gender", "Sex"], 4);
        var colStatus = getColIdx(["Call Status", "Status"], 5);
        var colApptGiven = getColIdx(["Appointment Given", "Appointment"], 6);
        var colApptDate = getColIdx(["Appointment Date/Time", "Appointment Date", "Appt Date"], 7);
        var colBiReq = getColIdx(["BI Required", "BI"], 8);
        var colBiProd = getColIdx(["BI Product Category", "BI Product", "Product"], 9);
        var colComments = getColIdx(["Call Comments", "Comments", "Remarks", "Remarks / Comments", "Notes"], 10);
        var colAddedBy = getColIdx(["Added By", "Agent", "Caller", "User", "Addedby"], 11);
        
        // Loop backwards to return newest records first (skip header row 0)
        for (var i = values.length - 1; i >= 1; i--) {
          try {
            var row = values[i];
            var customerName = row[colName] ? row[colName].toString().trim() : "";
            if (!customerName || customerName === "") continue; // Skip blank rows safely
            
            // Safe Timestamp Parsing
            var timestampStr = "";
            var rawTimestamp = row[colTimestamp];
            try {
              if (rawTimestamp instanceof Date && !isNaN(rawTimestamp.getTime())) {
                timestampStr = rawTimestamp.toISOString();
              } else if (rawTimestamp) {
                var parsedDate = new Date(rawTimestamp);
                if (!isNaN(parsedDate.getTime())) {
                  timestampStr = parsedDate.toISOString();
                } else {
                  timestampStr = new Date().toISOString();
                }
              } else {
                timestampStr = new Date().toISOString();
              }
            } catch (dateErr) {
              timestampStr = new Date().toISOString();
            }
            
            // Safe Mobile Number Parsing
            var mobileStr = "";
            var rawMobile = row[colMobile];
            if (rawMobile !== null && rawMobile !== undefined) {
              mobileStr = rawMobile.toString().trim();
              // If scientific or float with trailing .0, clean it
              if (mobileStr.indexOf('.') !== -1) {
                mobileStr = mobileStr.split('.')[0];
              }
              mobileStr = mobileStr.replace(/'/g, "");
            }
            
            var ageVal = row[colAge];
            if (ageVal === "N/A" || ageVal === "" || ageVal === undefined || ageVal === null) {
              ageVal = "";
            } else {
              ageVal = parseInt(ageVal, 10) || "";
            }
            
            var apptGiven = row[colApptGiven] === "Yes" || row[colApptGiven] === true;
            var biReq = row[colBiReq] === "Yes" || row[colBiReq] === true;
            
            // Bulletproof string conversion for all fields
            var gender = row[colGender] ? row[colGender].toString().trim() : "N/A";
            var status = row[colStatus] ? row[colStatus].toString().trim() : "Thinking";
            var apptDate = row[colApptDate] === "N/A" || !row[colApptDate] ? null : row[colApptDate].toString().trim();
            var biProduct = row[colBiProd] === "N/A" || !row[colBiProd] ? null : row[colBiProd].toString().trim();
            var comments = row[colComments] === "N/A" || !row[colComments] ? "" : row[colComments].toString().trim();
            var addedBy = row[colAddedBy] === "N/A" || !row[colAddedBy] ? "" : row[colAddedBy].toString().trim();
            
            dataList.push({
              id: timestampStr + "_" + mobileStr, // Composite Unique ID
              timestamp: timestampStr,
              name: customerName,
              mobile: mobileStr,
              age: ageVal,
              gender: gender,
              status: status,
              appointmentGiven: apptGiven,
              appointmentDate: apptDate,
              biRequired: biReq,
              biProduct: biProduct,
              comments: comments,
              addedBy: addedBy,
              syncStatus: "Synced"
            });
          } catch (rowError) {
            // Log row parsing errors in Apps Script Execution Logs rather than crashing the sync!
            console.log("Error parsing row index " + i + ": " + rowError.toString());
          }
        }
      }
      
      return ContentService.createTextOutput(JSON.stringify({
        status: "success",
        records: dataList
      }))
      .setMimeType(ContentService.MimeType.JSON);
    }
    
    // Connection test default response
    return ContentService.createTextOutput(JSON.stringify({
      status: "connected",
      message: "Web App URL is configured correctly and online!"
    }))
    .setMimeType(ContentService.MimeType.JSON);
    
  } catch (error) {
    return ContentService.createTextOutput(JSON.stringify({
      status: "error",
      message: error.toString()
    }))
    .setMimeType(ContentService.MimeType.JSON);
  }
}

// Automatically scans all sheet tabs to find the one containing telecaller logs (Self-Healing)
function findLogsSheet(ss) {
  var sheets = ss.getSheets();
  for (var i = 0; i < sheets.length; i++) {
    var sheet = sheets[i];
    var lastRow = sheet.getLastRow();
    if (lastRow > 0) {
      try {
        // Read the first row (headers)
        var headers = sheet.getRange(1, 1, 1, Math.min(sheet.getLastColumn(), 15)).getValues()[0];
        // Clean headers to strings
        var cleanHeaders = headers.map(function(h) { return h ? h.toString().trim() : ""; });
        // Lock onto any sheet tab containing customer name or mobile number columns
        if (cleanHeaders.indexOf("Customer Name") !== -1 || 
            cleanHeaders.indexOf("Mobile Number") !== -1 || 
            cleanHeaders.indexOf("Name") !== -1 ||
            cleanHeaders.indexOf("Mobile") !== -1) {
          return sheet; // Found the active logs sheet!
        }
      } catch(err) {
        // Continue scanning sheets if range reading fails
      }
    }
  }
  return sheets[0]; // Fallback to the first sheet if none matched
}
