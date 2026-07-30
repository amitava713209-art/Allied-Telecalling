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

    // --- USER AUTH & PIN VERIFICATION HANDLER ---
    if (data && data.action === "verify_user") {
      var userSheet = ss.getSheetByName("Users");
      if (!userSheet) {
        userSheet = ss.insertSheet("Users");
        userSheet.appendRow(["Caller Name", "PIN", "Status", "Role"]);
        userSheet.getRange(1, 1, 1, 4).setFontWeight("bold").setBackground("#4f46e5").setFontColor("#ffffff");
        userSheet.appendRow(["Master Admin", "1234", "Active", "Admin"]);
        userSheet.appendRow(["Moupriya", "1024", "Active", "Caller"]);
        userSheet.appendRow(["Pankaj", "2048", "Active", "Caller"]);
      }
      
      var uData = userSheet.getDataRange().getValues();
      var reqPin = String(data.pin || "").trim();
      var reqName = String(data.name || "").trim().toLowerCase();
      var foundUser = null;
      
      for (var u = 1; u < uData.length; u++) {
        var uName = String(uData[u][0] || "").trim().toLowerCase();
        var uPin = String(uData[u][1] || "").trim();
        var uStatus = String(uData[u][2] || "").trim();
        var uRole = String(uData[u][3] || "").trim();
        
        if ((uName === reqName || !reqName) && uPin === reqPin) {
          foundUser = {
            name: uData[u][0],
            status: uStatus,
            role: uRole
          };
          break;
        }
      }
      
      var resObj = {};
      if (foundUser) {
        if (foundUser.status.toLowerCase() === "active") {
          resObj = { status: "success", authorized: true, name: foundUser.name, role: foundUser.role };
          logAudit(ss, foundUser.name, "LOGIN", "Logged into application successfully.");
        } else {
          resObj = { status: "error", authorized: false, message: "Account Revoked. Please contact Admin." };
          logAudit(ss, foundUser.name, "BLOCKED_LOGIN", "Attempted login on revoked account.");
        }
      } else {
        resObj = { status: "error", authorized: false, message: "Invalid Name or Security PIN." };
        logAudit(ss, reqName || "Unknown", "FAILED_LOGIN", "Failed PIN authentication attempt.");
      }
      
      return ContentService.createTextOutput(JSON.stringify(resObj)).setMimeType(ContentService.MimeType.JSON);
    }

    // --- SECURITY AUDIT LOGGING HANDLER ---
    if (data && data.action === "log_audit") {
      logAudit(ss, data.callerName || "System", data.eventType || "ACTION", data.details || "");
      return ContentService.createTextOutput(JSON.stringify({ status: "success" })).setMimeType(ContentService.MimeType.JSON);
    }

    // --- CENTRAL LEAD QUEUE IMPORT HANDLER ---
    if (data && data.action === "upload_queue" && data.leads) {
      var queueSheet = ss.getSheetByName("Lead Queue");
      if (!queueSheet) {
        queueSheet = ss.insertSheet("Lead Queue");
      }
      if (queueSheet.getLastRow() === 0) {
        queueSheet.appendRow(["ID", "Name", "Mobile Number", "Age", "Gender", "City", "Status"]);
        queueSheet.getRange(1, 1, 1, 7).setFontWeight("bold").setBackground("#059669").setFontColor("#ffffff");
      }
      
      var existingData = queueSheet.getDataRange().getValues();
      var existingMobiles = {};
      for (var q = 1; q < existingData.length; q++) {
        var m = existingData[q][2] ? existingData[q][2].toString().replace(/[^0-9]/g, "") : "";
        if (m) existingMobiles[m] = true;
      }
      
      var newRows = [];
      data.leads.forEach(function(lead) {
        var mobClean = lead.mobile ? lead.mobile.toString().replace(/[^0-9]/g, "") : "";
        if (mobClean && !existingMobiles[mobClean]) {
          newRows.push([
            lead.id || ("lead_" + new Date().getTime() + "_" + Math.floor(Math.random()*1000)),
            lead.name || "Lead",
            "'" + mobClean,
            lead.age || "",
            lead.gender || "",
            lead.city || "",
            lead.status || "Pending"
          ]);
          existingMobiles[mobClean] = true;
        }
      });
      
      if (newRows.length > 0) {
        queueSheet.getRange(queueSheet.getLastRow() + 1, 1, newRows.length, 7).setValues(newRows);
      }
      
      return ContentService.createTextOutput(JSON.stringify({
        status: "success",
        message: "Successfully uploaded " + newRows.length + " new leads to central Lead Queue tab!"
      })).setMimeType(ContentService.MimeType.JSON);
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
    
    // Also mark lead queue item as called in central tab if present
    var queueSheetRef = ss.getSheetByName("Lead Queue");
    if (queueSheetRef && searchMobile) {
      var qData = queueSheetRef.getDataRange().getValues();
      for (var qIdx = 1; qIdx < qData.length; qIdx++) {
        var qMob = qData[qIdx][2] ? qData[qIdx][2].toString().replace(/[^0-9]/g, "") : "";
        if (qMob === searchMobile) {
          queueSheetRef.getRange(qIdx + 1, 7).setValue("Called");
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
    
    // Check if request is to pull central Lead Queue
    if (e && e.parameter && e.parameter.action === "fetch_queue") {
      var qSheet = ss.getSheetByName("Lead Queue");
      var qList = [];
      if (qSheet && qSheet.getLastRow() > 1) {
        var qValues = qSheet.getRange(2, 1, qSheet.getLastRow() - 1, 7).getValues();
        qValues.forEach(function(r) {
          var mob = r[2] ? r[2].toString().replace(/[^0-9]/g, "") : "";
          if (mob) {
            qList.push({
              id: r[0] || ("lead_" + Math.random()),
              name: r[1] || "Lead",
              mobile: mob,
              age: r[3] || "",
              gender: r[4] || "",
              city: r[5] || "",
              status: r[6] || "Pending"
            });
          }
        });
      }
      var qObj = {
        status: "success",
        queue: qList
      };

      if (e && e.parameter && e.parameter.callback) {
        return ContentService.createTextOutput(e.parameter.callback + "(" + JSON.stringify(qObj) + ")")
          .setMimeType(ContentService.MimeType.JAVASCRIPT);
      }

      return ContentService.createTextOutput(JSON.stringify(qObj)).setMimeType(ContentService.MimeType.JSON);
    }
    
    // Check if the request is to pull call data
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
                timestampStr = new Date(rawTimestamp).toISOString();
              } else {
                timestampStr = new Date().toISOString();
              }
            } catch (e) {
              timestampStr = new Date().toISOString();
            }
            
            var mobileStr = row[colMobile] ? row[colMobile].toString().replace(/[^0-9]/g, "") : "";
            var ageVal = row[colAge] ? parseInt(row[colAge], 10) || "" : "";
            var gender = row[colGender] ? row[colGender].toString().trim() : "";
            var status = row[colStatus] ? row[colStatus].toString().trim() : "";
            var apptGivenStr = row[colApptGiven] ? row[colApptGiven].toString().toLowerCase().trim() : "";
            var apptGiven = (apptGivenStr === "yes" || apptGivenStr === "true");
            var apptDate = row[colApptDate] ? row[colApptDate].toString().trim() : "";
            var biReqStr = row[colBiReq] ? row[colBiReq].toString().toLowerCase().trim() : "";
            var biReq = (biReqStr === "yes" || biReqStr === "true");
            var biProduct = row[colBiProd] ? row[colBiProd].toString().trim() : "";
            var comments = row[colComments] ? row[colComments].toString().trim() : "";
            var addedBy = row[colAddedBy] ? row[colAddedBy].toString().trim() : "";

            dataList.push({
              id: "remote_" + i + "_" + mobileStr,
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
      
      var resObj = {
        status: "success",
        records: dataList
      };

      if (e && e.parameter && e.parameter.callback) {
        return ContentService.createTextOutput(e.parameter.callback + "(" + JSON.stringify(resObj) + ")")
          .setMimeType(ContentService.MimeType.JAVASCRIPT);
      }

      return ContentService.createTextOutput(JSON.stringify(resObj))
      .setMimeType(ContentService.MimeType.JSON);
    }
    
    // Connection test default response
    var connObj = {
      status: "connected",
      message: "Web App URL is configured correctly and online!"
    };

    if (e && e.parameter && e.parameter.callback) {
      return ContentService.createTextOutput(e.parameter.callback + "(" + JSON.stringify(connObj) + ")")
        .setMimeType(ContentService.MimeType.JAVASCRIPT);
    }

    return ContentService.createTextOutput(JSON.stringify(connObj))
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

// Helper function to record Security Audit Logs in Google Sheet
function logAudit(ss, callerName, eventType, details) {
  try {
    var auditSheet = ss.getSheetByName("Security Audit Log");
    if (!auditSheet) {
      auditSheet = ss.insertSheet("Security Audit Log");
      auditSheet.appendRow(["Timestamp", "Caller Name", "Event Type", "Details"]);
      auditSheet.getRange(1, 1, 1, 4).setFontWeight("bold").setBackground("#dc2626").setFontColor("#ffffff");
    }
    auditSheet.appendRow([new Date(), callerName, eventType, details]);
  } catch(e) {
    console.log("Could not write audit log:", e);
  }
}
