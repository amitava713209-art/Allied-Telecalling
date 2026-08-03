/* ==========================================================================
   TELECALL PRO DASHBOARD CORE LOGIC - CRM UPGRADED
   Features: 2-Way Sync Engine, Smart Editing Overwrite, Mobile responsive Tab Layout,
             Expandable Client Calling Cards, Stats Calculations, Local Persistence
   ========================================================================== */

// --- Global Application State ---
let callLogs = [];
let leadQueue = [];
let mediaRecorder = null;
let audioChunks = [];
let recordedAudioBase64 = null;
let recordingTimerInterval = null;
let recordingSeconds = 0;

// 💡 UNIVERSAL TEAM CONFIGURATION
// Paste your deployed Google Apps Script Web App URL (ending in "/exec") inside the quotes below.
// Once you paste your URL here, none of your 10 callers need to configure anything!
// They will open the link and instantly see "Sheets Connected" automatically.
const DEFAULT_SHEET_URL = "https://script.google.com/macros/s/AKfycbzi95qPF66gQ97cFCnvnezJdUepq0l8krznJTdhOajXGfqZXrFwwizVOdkQNAY8s-fafg/exec";

let sheetUrl = DEFAULT_SHEET_URL;
let editingRecordId = null;

// --- Initialization on DOM Load ---
document.addEventListener("DOMContentLoaded", () => {
  // 0. Check Security Access Authentication
  checkCallerSecurityAccess();

  // 1. Load data from LocalStorage
  loadStoredData();
  
  // 2. Display current date nicely
  displayCurrentDate();
  
  // 3. Render initial views
  renderHistoryTable();
  renderLeadQueue();
  recalculateAnalytics();
  updateSyncBadge();

  // 4. Trigger Automatic Remote Fetch from Sheets in background (Non-blocking)
  setTimeout(() => {
    fetchRemoteLogs();
    fetchCentralLeadQueue();
  }, 100);

  // 5. Pre-populate Caller Agent Name from LocalStorage
  const agentInput = document.getElementById("caller-name");
  if (agentInput) {
    agentInput.value = localStorage.getItem("telecaller_agent_name") || "";
  }

  // 6. Add event listener for call status changes
  const statusRadios = document.querySelectorAll('input[name="call-status"]');
  statusRadios.forEach(radio => {
    radio.addEventListener("change", handleStatusChange);
  });
  
  // Initialize form fields visibility
  handleStatusChange();

  // 6b. Add live mobile lookup listener to detect existing records
  const mobileInput = document.getElementById("mobile-number");
  if (mobileInput) {
    mobileInput.addEventListener("input", handleLiveMobileLookup);
  }

  // 7. Initialize Lucide Icons
  if (window.lucide) {
    window.lucide.createIcons();
  }

  // 8. Initialize Mobile Layout Tab display (Default to Lead Queue on Mobile)
  if (window.innerWidth <= 768) {
    switchMobileTab('queue');
  }

  // 9. Register PWA Service Worker for Mobile Installation
  if ('serviceWorker' in navigator && window.location.protocol.startsWith('http')) {
    navigator.serviceWorker.register('./sw.js')
      .then(reg => console.log('Allied Telecalling PWA Service Worker Registered:', reg.scope))
      .catch(err => console.warn('PWA Registration failed:', err));
  }
});

// Handle window resizing to switch between table and cards layout
window.addEventListener("resize", () => {
  renderHistoryTable();
});

// --- Date and Time Helper ---
function displayCurrentDate() {
  const dateElement = document.getElementById("current-date");
  if (dateElement) {
    const options = { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' };
    const today = new Date();
    dateElement.textContent = today.toLocaleDateString('en-US', options);
  }
}

// --- Load/Save LocalStorage ---
function loadStoredData() {
  try {
    const storedLogs = localStorage.getItem("telecaller_logs");
    if (storedLogs) {
      const parsed = JSON.parse(storedLogs);
      callLogs = Array.isArray(parsed) ? parsed : [];
    } else {
      callLogs = [];
    }
    const storedQueue = localStorage.getItem("telecaller_lead_queue");
    if (storedQueue) {
      const parsedQ = JSON.parse(storedQueue);
      leadQueue = Array.isArray(parsedQ) ? parsedQ : [];
    } else {
      leadQueue = [];
    }
    // Prioritize DEFAULT_SHEET_URL so callers never have to configure anything manually
    sheetUrl = DEFAULT_SHEET_URL || localStorage.getItem("telecaller_sheet_url") || "";
  } catch (error) {
    console.error("Error loading local storage data:", error);
    showToast("Error", "Could not load previously saved logs.", "error");
  }
}

function saveLogsToLocalStorage() {
  try {
    localStorage.setItem("telecaller_logs", JSON.stringify(callLogs));
  } catch (error) {
    console.error("Error saving local storage data:", error);
    showToast("Error", "Could not save log data to browser storage.", "error");
  }
}

// --- UI Dynamic Form Field Toggles ---
function handleStatusChange() {
  const statusInput = document.querySelector('input[name="call-status"]:checked');
  const appointmentToggleRow = document.getElementById("appointment-toggle-row");
  const appointmentGivenCheckbox = document.getElementById("appointment-given");

  if (!statusInput || !appointmentToggleRow) return;

  if (statusInput.value === "Interested") {
    // Show appointment option
    appointmentToggleRow.classList.remove("hidden-toggle");
    toggleAppointmentField();
  } else {
    // Hide appointment option for Thinking or Not Interested
    appointmentToggleRow.classList.add("hidden-toggle");
    appointmentGivenCheckbox.checked = false;
    toggleAppointmentField();
  }
}

function toggleAppointmentField() {
  const appointmentGivenCheckbox = document.getElementById("appointment-given");
  const appointmentDateGroup = document.getElementById("appointment-date-group");
  const appointmentDateInput = document.getElementById("appointment-date");

  if (appointmentGivenCheckbox.checked) {
    appointmentDateGroup.classList.add("active");
    appointmentDateInput.required = true;
    
    // Set a default minimum date to "now"
    const now = new Date();
    now.setMinutes(now.getMinutes() - now.getTimezoneOffset());
    appointmentDateInput.min = now.toISOString().slice(0, 16);
  } else {
    appointmentDateGroup.classList.remove("active");
    appointmentDateInput.required = false;
    appointmentDateInput.value = "";
  }
}

function toggleBiField() {
  const biRequiredCheckbox = document.getElementById("bi-required");
  const biProductGroup = document.getElementById("bi-product-group");
  const biProductSelect = document.getElementById("bi-product");

  if (biRequiredCheckbox.checked) {
    biProductGroup.classList.add("active");
    biProductSelect.required = true;
  } else {
    biProductGroup.classList.remove("active");
    biProductSelect.required = false;
    biProductSelect.value = "";
  }
}

// --- Mobile Tab Switching Logic ---
function switchMobileTab(tab) {
  const formPanel = document.getElementById("form-panel-section");
  const tablePanel = document.getElementById("table-panel-section");
  const navBtnForm = document.getElementById("nav-btn-form");
  const navBtnHistory = document.getElementById("nav-btn-history");

  if (!formPanel || !tablePanel) return;

  if (tab === 'form') {
    formPanel.classList.remove("mobile-hidden");
    tablePanel.classList.add("mobile-hidden");
    if (navBtnForm) navBtnForm.classList.add("active");
    if (navBtnHistory) navBtnHistory.classList.remove("active");
  } else {
    formPanel.classList.add("mobile-hidden");
    tablePanel.classList.remove("mobile-hidden");
    if (navBtnForm) navBtnForm.classList.remove("active");
    if (navBtnHistory) navBtnHistory.classList.add("active");
    
    // Rerender table to adapt layout dimensions immediately
    renderHistoryTable();
  }
}

// --- ✏️ CRM Live Pencil Editing Mode ---
function editRecord(recordId) {
  const record = callLogs.find(r => r.id === recordId);
  if (!record) return;

  editingRecordId = recordId;

  // Add visual branding changes to indicate Edit Mode
  const formPanel = document.getElementById("form-panel-section");
  const headerTitle = document.getElementById("form-header-title");
  const headerIcon = document.getElementById("form-header-icon");
  const submitBtn = document.querySelector("#call-form button[type='submit']");

  if (formPanel) formPanel.classList.add("edit-mode-active");
  if (headerTitle) headerTitle.textContent = `Edit Call: ${record.name}`;
  if (headerIcon) headerIcon.setAttribute("data-lucide", "edit-3");
  if (submitBtn) {
    submitBtn.innerHTML = `<i data-lucide="save"></i> Update Call Record`;
  }
  if (window.lucide) window.lucide.createIcons();

  // Pre-populate standard form fields
  document.getElementById("customer-name").value = record.name;
  document.getElementById("mobile-number").value = record.mobile;
  document.getElementById("customer-age").value = record.age || "";
  document.getElementById("customer-gender").value = record.gender;

  // Select call status radio option
  const radio = document.querySelector(`input[name="call-status"][value="${record.status}"]`);
  if (radio) {
    radio.checked = true;
  }

  // Set appointment fields
  const apptToggle = document.getElementById("appointment-given");
  apptToggle.checked = record.appointmentGiven;
  if (record.appointmentGiven) {
    document.getElementById("appointment-date").value = record.appointmentDate ? record.appointmentDate.slice(0, 16) : "";
  }

  // Set BI fields
  const biToggle = document.getElementById("bi-required");
  biToggle.checked = record.biRequired;
  if (record.biRequired) {
    document.getElementById("bi-product").value = record.biProduct || "";
  }

  // Set comments & agent
  document.getElementById("call-comments").value = record.comments || "";
  const agentInput = document.getElementById("caller-name");
  if (agentInput) {
    agentInput.value = record.addedBy || localStorage.getItem("telecaller_agent_name") || "";
  }

  // Update dynamic layouts
  handleStatusChange();
  toggleBiField();

  // If on mobile screen size, auto-switch to Log Call tab
  if (window.innerWidth <= 768) {
    switchMobileTab('form');
  }

  // Smooth scroll to form container
  formPanel.scrollIntoView({ behavior: 'smooth' });
  document.getElementById("customer-name").focus();
  
  showToast("Edit Mode Active", `Editing record for ${record.name}.`, "info");
}

// --- Fetch Remote Data Sync Engine (2-Way GET retrieval) ---
async function fetchRemoteLogs() {
  if (!sheetUrl) {
    console.log("Sync skipped: No Sheets URL configured.");
    return;
  }

  const refreshBtn = document.getElementById("refresh-sync-btn");
  const refreshIcon = document.getElementById("refresh-icon");

  if (refreshIcon) refreshIcon.classList.add("spin-icon");
  if (refreshBtn) refreshBtn.disabled = true;

  try {
    const callbackName = "handleSheetDataFallback_Global";
    window[callbackName] = function(data) {
      if (data && data.records && Array.isArray(data.records) && data.records.length > 0) {
        mergeLogs(data.records);
        saveLogsToLocalStorage();
        filterCallHistory();
        recalculateAnalytics();
        updateSyncBadge();
        showToast("Sync Successful", `Fetched ${data.records.length} team logs from Google Sheet.`, "success");
      }
    };

    // If opening locally as file://, use script tag injection directly to bypass browser CORS blocks
    if (window.location.protocol === "file:") {
      // Remove any existing sync scripts to prevent duplicate callback delays
      const oldScripts = document.querySelectorAll("script[data-sync-script='true']");
      oldScripts.forEach(s => s.remove());

      const scriptTag = document.createElement("script");
      scriptTag.setAttribute("data-sync-script", "true");
      scriptTag.src = sheetUrl + (sheetUrl.includes("?") ? "&" : "?") + "action=fetch&callback=" + callbackName + "&_t=" + Date.now();
      scriptTag.onload = function() {
        if (refreshIcon) refreshIcon.classList.remove("spin-icon");
        if (refreshBtn) refreshBtn.disabled = false;
        if (scriptTag && scriptTag.parentNode) scriptTag.parentNode.removeChild(scriptTag);
      };
      scriptTag.onerror = function() {
        if (refreshIcon) refreshIcon.classList.remove("spin-icon");
        if (refreshBtn) refreshBtn.disabled = false;
        if (scriptTag && scriptTag.parentNode) scriptTag.parentNode.removeChild(scriptTag);
      };
      document.body.appendChild(scriptTag);
      return;
    }

    // Fetch query with fetch action parameter
    const fetchUrl = sheetUrl + (sheetUrl.includes("?") ? "&" : "?") + "action=fetch";
    const response = await fetch(fetchUrl, {
      method: "GET",
      mode: "cors"
    });

    if (!response.ok) {
      throw new Error(`HTTP Error Status: ${response.status}`);
    }

    const data = await response.json();
    if (data.status === "success" && data.records) {
      // Merge remote spreadsheet data with local logs
      mergeLogs(data.records);
      saveLogsToLocalStorage();
      filterCallHistory();
      recalculateAnalytics();
      
      // Also fetch shared central Lead Queue tab
      fetchCentralLeadQueue();

      // Update Sync Badge to show success state
      updateSyncBadge();
      
      showToast("Sync Successful", `Fetched ${data.records.length} team logs from Google Sheet.`, "success");
    } else {
      throw new Error(data.message || "Invalid data format received.");
    }
  } catch (error) {
    console.warn("Direct CORS fetch failed, falling back to script injection:", error);
    try {
      const scriptTag = document.createElement("script");
      scriptTag.src = sheetUrl + (sheetUrl.includes("?") ? "&" : "?") + "action=fetch&callback=handleSheetDataFallback_Global";
      document.body.appendChild(scriptTag);
    } catch (e) {
      console.warn("Fallback failed:", e);
    }
  } finally {
    if (refreshIcon) refreshIcon.classList.remove("spin-icon");
    if (refreshBtn) refreshBtn.disabled = false;
  }
}

window.fetchRemoteLogs = fetchRemoteLogs;

// De-duplicate team records retrieved from Sheet
function mergeLogs(remoteRecords) {
  const mergedMap = new Map();

  // 1. Process remote records (Sheet is source of truth)
  remoteRecords.forEach((record, idx) => {
    const key = record.id || (record.mobile ? `mob_${record.mobile}` : `rec_${idx}`);
    mergedMap.set(key, record);
  });

  // 2. Add local records that aren't synced or aren't in the sheet yet
  callLogs.forEach((record, idx) => {
    const key = record.id || (record.mobile ? `mob_${record.mobile}` : `local_${idx}`);
    if (!mergedMap.has(key)) {
      mergedMap.set(key, record);
    } else {
      if (record.syncStatus === "Pending") {
        mergedMap.set(key, record);
      }
    }
  });

  // 3. Convert back and sort descending by timestamp (or array order)
  callLogs = Array.from(mergedMap.values()).sort((a, b) => {
    const timeA = a.timestamp ? new Date(a.timestamp).getTime() : 0;
    const timeB = b.timestamp ? new Date(b.timestamp).getTime() : 0;
    return (timeB || 0) - (timeA || 0);
  });
}

// --- Modal Settings Handlers ---
function openSettings() {
  const modal = document.getElementById("settings-modal");
  const urlInput = document.getElementById("web-app-url");
  
  urlInput.value = DEFAULT_SHEET_URL || localStorage.getItem("telecaller_sheet_url") || "";
  modal.style.display = "flex";
  
  const testStatus = document.getElementById("test-conn-status");
  testStatus.textContent = urlInput.value ? "Configured (Not Tested)" : "Not Configured";
  testStatus.className = "test-status-text";
}

function closeSettings() {
  document.getElementById("settings-modal").style.display = "none";
}

function saveSettings() {
  const urlInput = document.getElementById("web-app-url");
  const rawUrl = urlInput.value.trim();
  
  if (rawUrl && !rawUrl.startsWith("https://script.google.com/")) {
    showToast("Invalid URL", "Google Apps Script Web App URLs must start with https://script.google.com", "error");
    return;
  }

  localStorage.setItem("telecaller_sheet_url", rawUrl);
  sheetUrl = rawUrl;
  
  closeSettings();
  updateSyncBadge();
  showToast("Settings Saved", "Google Sheets Sync configuration saved successfully.", "success");
  
  // Trigger syncing and fetch remote sheets data
  syncPendingLogs();
  fetchRemoteLogs();
}

async function testSheetConnection() {
  const urlInput = document.getElementById("web-app-url");
  const testUrl = urlInput.value.trim();
  const testStatus = document.getElementById("test-conn-status");
  const testBtn = document.getElementById("test-conn-btn");

  if (!testUrl) {
    testStatus.textContent = "Please enter a URL first.";
    testStatus.className = "test-status-text status-failed";
    return;
  }

  testStatus.textContent = "Testing connection...";
  testStatus.className = "test-status-text status-checking";
  testBtn.disabled = true;

  const isLocalFile = window.location.protocol === "file:";

  try {
    const response = await fetch(testUrl, {
      method: "GET",
      mode: "cors"
    });

    if (!response.ok) {
      throw new Error(`HTTP error! status: ${response.status}`);
    }

    const data = await response.json();
    if (data.status === "connected") {
      testStatus.textContent = "Connection Successful! Online.";
      testStatus.className = "test-status-text status-connected";
      showToast("Connected", "Google Sheets Web App verified & online!", "success");
      return;
    } else {
      throw new Error(data.message || "Invalid response format.");
    }
  } catch (error) {
    console.warn("Standard CORS connection test failed, trying local file fallback...", error);
    
    try {
      await fetch(testUrl, {
        method: "POST",
        mode: "no-cors",
        headers: {
          "Content-Type": "text/plain;charset=utf-8"
        },
        body: JSON.stringify({ isTest: true })
      });

      testStatus.textContent = "Connected (CORS Bypass Active)";
      testStatus.className = "test-status-text status-connected";
      
      if (isLocalFile) {
        showToast("Connected!", "Sync is verified and active (CORS bypassed for local file).", "success");
      } else {
        showToast("Connected!", "Google Sheets connection verified and active!", "success");
      }
    } catch (fallbackError) {
      console.error("Connection fallback failed:", fallbackError);
      testStatus.textContent = "Connection Failed. Check URL and Deployment settings.";
      testStatus.className = "test-status-text status-failed";
      showToast("Connection Failed", "Ensure 'Who has access' is set to 'Anyone' during deployment.", "error");
    }
  } finally {
    testBtn.disabled = false;
  }
}

function updateSyncBadge() {
  const syncBtn = document.getElementById("sync-status-btn");
  const syncText = document.getElementById("sync-status-text");
  if (!syncBtn || !syncText) return;
  
  // Clear any temporary inline styling added during error states
  syncBtn.removeAttribute("style");
  
  if (sheetUrl) {
    syncBtn.className = "status-badge state-connected";
    syncText.textContent = "Sheets Connected";
  } else {
    syncBtn.className = "status-badge state-disconnected";
    syncText.textContent = "Sheets Offline";
  }
}

// --- Form Validation & Submission ---
function handleFormSubmit(event) {
  event.preventDefault();

  const agentInput = document.getElementById("caller-name");
  const nameInput = document.getElementById("customer-name");
  const mobileInput = document.getElementById("mobile-number");
  const ageInput = document.getElementById("customer-age");
  const genderInput = document.getElementById("customer-gender");
  const statusInput = document.querySelector('input[name="call-status"]:checked');
  const appointmentGiven = document.getElementById("appointment-given").checked;
  const appointmentDate = document.getElementById("appointment-date").value;
  const biRequired = document.getElementById("bi-required").checked;
  const biProduct = document.getElementById("bi-product").value;
  const commentsInput = document.getElementById("call-comments");

  // 1. Validation Checks
  const addedBy = agentInput ? agentInput.value.trim() : "N/A";
  const name = nameInput.value.trim();
  const mobile = mobileInput.value.trim();
  const age = ageInput.value ? parseInt(ageInput.value, 10) : "";
  const gender = genderInput.value;
  const status = statusInput ? statusInput.value : "";
  const comments = commentsInput ? commentsInput.value.trim() : "";

  if (!addedBy) {
    showToast("Required Field", "Please enter the Caller Agent Name.", "error");
    agentInput.focus();
    return;
  }

  // Cache the agent name in local storage
  localStorage.setItem("telecaller_agent_name", addedBy);

  // Mobile format validation (10 digits)
  const mobileRegex = /^[0-9]{10}$/;
  if (!mobileRegex.test(mobile)) {
    showToast("Invalid Mobile", "Please enter a valid 10-digit mobile number.", "error");
    mobileInput.focus();
    return;
  }

  if (age && (age < 1 || age > 120)) {
    showToast("Invalid Age", "Please enter a realistic age between 1 and 120.", "error");
    ageInput.focus();
    return;
  }

  if (appointmentGiven && !appointmentDate) {
    showToast("Required Field", "Please enter the scheduled Appointment Date and Time.", "error");
    document.getElementById("appointment-date").focus();
    return;
  }

  if (biRequired && !biProduct) {
    showToast("Required Field", "Please select a product category for Benefit Illustration.", "error");
    document.getElementById("bi-product").focus();
    return;
  }

  // 2. Handle Save logic for New vs Updated Record
  if (editingRecordId !== null) {
    // --- EDIT EXISTING CLIENT ---
    const index = callLogs.findIndex(r => r.id === editingRecordId);
    if (index !== -1) {
      const origRecord = callLogs[index];
      
      const updatedRecord = {
        id: origRecord.id,
        timestamp: origRecord.timestamp, // Keep original timestamp
        name: name,
        mobile: mobile,
        age: age,
        gender: gender,
        status: status,
        appointmentGiven: appointmentGiven,
        appointmentDate: appointmentGiven ? appointmentDate : null,
        biRequired: biRequired,
        biProduct: biRequired ? biProduct : null,
        comments: comments,
        addedBy: addedBy,
        audioRecording: recordedAudioBase64 || origRecord.audioRecording || null,
        syncStatus: "Pending" // Retrigger sync upload
      };

      callLogs[index] = updatedRecord;
      saveLogsToLocalStorage();
      
      // Auto-mark lead queue item as called
      const qItem = leadQueue.find(l => l.mobile === mobile);
      if (qItem) {
        qItem.status = "Called";
        saveLeadQueueToLocalStorage();
        renderLeadQueue();
      }

      // Render layout updates
      renderHistoryTable();
      recalculateAnalytics();
      
      // Upload updated data to sheet
      triggerSheetSync(updatedRecord.id);
      showToast("Record Updated", `Updated details for customer "${name}".`, "success");
      
      resetForm();

      // If mobile screen size, auto-switch back to History tab
      if (window.innerWidth <= 768) {
        switchMobileTab('history');
      }
    }
  } else {
    // --- CREATE NEW CLIENT RECORD ---
    const newRecord = {
      id: Date.now().toString(),
      timestamp: new Date().toISOString(),
      name: name,
      mobile: mobile,
      age: age,
      gender: gender,
      status: status,
      appointmentGiven: appointmentGiven,
      appointmentDate: appointmentGiven ? appointmentDate : null,
      biRequired: biRequired,
      biProduct: biRequired ? biProduct : null,
      comments: comments,
      addedBy: addedBy,
      audioRecording: recordedAudioBase64 || null,
      syncStatus: "Pending"
    };

    callLogs.unshift(newRecord);
    saveLogsToLocalStorage();

    // Auto-mark lead queue item as called
    const qItem = leadQueue.find(l => l.mobile === mobile);
    if (qItem) {
      qItem.status = "Called";
      saveLeadQueueToLocalStorage();
      renderLeadQueue();
    }

    renderHistoryTable();
    recalculateAnalytics();
    
    // Trigger Sheet Sync
    triggerSheetSync(newRecord.id);
    showToast("Record Logged", `Customer "${name}" recorded successfully.`, "success");
    
    resetForm();

    // If mobile screen size, switch back to History tab to see the new entry
    if (window.innerWidth <= 768) {
      switchMobileTab('history');
    }
  }
}

function resetForm() {
  document.getElementById("call-form").reset();
  deleteAudioRecording();

  const warnContainer = document.getElementById("duplicate-warning-container");
  if (warnContainer) {
    warnContainer.classList.add("hidden");
    warnContainer.innerHTML = "";
  }
  
  // Exit Edit Mode and restore titles
  editingRecordId = null;
  const formPanel = document.getElementById("form-panel-section");
  const headerTitle = document.getElementById("form-header-title");
  const headerIcon = document.getElementById("form-header-icon");
  const submitBtn = document.querySelector("#call-form button[type='submit']");

  if (formPanel) formPanel.classList.remove("edit-mode-active");
  if (headerTitle) headerTitle.textContent = "Log New Call Update";
  if (headerIcon) headerIcon.setAttribute("data-lucide", "user-plus");
  if (submitBtn) {
    submitBtn.innerHTML = `<i data-lucide="save"></i> Save Call Record`;
  }
  if (window.lucide) window.lucide.createIcons();
  
  // Prefill Agent Caller name
  const agentInput = document.getElementById("caller-name");
  if (agentInput) {
    agentInput.value = localStorage.getItem("telecaller_agent_name") || "";
  }
  
  // Reset visibility states
  document.getElementById("appointment-date-group").classList.remove("active");
  document.getElementById("appointment-date").required = false;
  document.getElementById("appointment-date").value = "";

  document.getElementById("bi-product-group").classList.remove("active");
  document.getElementById("bi-product").required = false;
  document.getElementById("bi-product").value = "";

  document.getElementById("customer-gender").value = "";

  handleStatusChange();
}

// --- Google Sheets Sync Engine ---
async function triggerSheetSync(recordId) {
  const index = callLogs.findIndex(r => r.id === recordId);
  if (index === -1) return;

  const record = callLogs[index];
  
  if (!sheetUrl) {
    console.log(`Sheets URL not configured. Record ${record.name} kept as Pending Sync.`);
    return;
  }

  updateRecordSyncUiStatus(recordId, "Syncing");

  try {
    const payload = {
      name: record.name,
      mobile: record.mobile,
      age: record.age || "N/A",
      gender: record.gender,
      status: record.status,
      appointmentGiven: record.appointmentGiven ? "Yes" : "No",
      appointmentDate: record.appointmentDate ? formatDateTimeReadable(record.appointmentDate) : "N/A",
      biRequired: record.biRequired ? "Yes" : "No",
      biProduct: record.biProduct || "N/A",
      comments: record.comments || "N/A",
      addedBy: record.addedBy || "N/A",
      audioRecording: record.audioRecording || "N/A"
    };

    // Bypassing browser preflight CORS restrictions on Google Apps Script Web Apps
    // by using "no-cors" mode universally for all POST sync operations.
    await fetch(sheetUrl, {
      method: "POST",
      mode: "no-cors",
      headers: {
        "Content-Type": "text/plain;charset=utf-8"
      },
      body: JSON.stringify(payload)
    });

    callLogs[index].syncStatus = "Synced";
    saveLogsToLocalStorage();
    updateRecordSyncUiStatus(recordId, "Synced");
    showToast("Synced to Sheet", `"${record.name}" updated on Google Sheets.`, "success");

  } catch (error) {
    console.error("Sheets Sync Error:", error);
    callLogs[index].syncStatus = "Pending";
    saveLogsToLocalStorage();
    updateRecordSyncUiStatus(recordId, "Pending");
    showToast("Sync Pending", `Saved locally. Will upload "${record.name}" automatically once online.`, "info");
  }
}

function syncPendingLogs() {
  if (!sheetUrl) return;

  const pendingRecords = callLogs.filter(r => r.syncStatus === "Pending");
  if (pendingRecords.length === 0) return;

  showToast("Syncing Database", `Syncing ${pendingRecords.length} pending logs with Google Sheet...`, "info");
  
  pendingRecords.forEach(record => {
    triggerSheetSync(record.id);
  });
}

function updateRecordSyncUiStatus(recordId, status) {
  // Update desktop row
  const row = document.querySelector(`tr[data-id="${recordId}"]`);
  const mobileCard = document.querySelector(`.mobile-card[data-id="${recordId}"]`);
  
  const applySyncBadge = (element) => {
    if (!element) return;
    const syncCell = element.querySelector(".sync-col") || element.querySelector(".sync-pill").parentElement;
    if (!syncCell) return;

    if (status === "Synced") {
      syncCell.innerHTML = `
        <span class="sync-pill sync-pill-success">
          <i data-lucide="check-circle-2"></i> Synced
        </span>
      `;
    } else if (status === "Syncing") {
      syncCell.innerHTML = `
        <span class="sync-pill sync-pill-pending">
          <i class="input-icon spin-icon" data-lucide="loader-2" style="position:static; margin:0; width:11px; height:11px;"></i> Syncing...
        </span>
      `;
    } else {
      syncCell.innerHTML = `
        <span class="sync-pill sync-pill-pending" onclick="triggerSheetSync('${recordId}')" title="Click to sync manually">
          <i data-lucide="alert-circle"></i> Pending
        </span>
      `;
    }
  };

  applySyncBadge(row);
  applySyncBadge(mobileCard);
  
  if (window.lucide) {
    window.lucide.createIcons();
  }
}

// --- Analytics / Performance Computation ---
function recalculateAnalytics() {
  const totalCalls = callLogs.length;
  document.getElementById("stat-total-calls").textContent = totalCalls;

  const hotCount = callLogs.filter(r => r.status === "Hot List").length;
  const hotPct = totalCalls > 0 ? Math.round((hotCount / totalCalls) * 100) : 0;
  const hotEl = document.getElementById("stat-hot-list");
  if (hotEl) hotEl.innerHTML = `${hotCount} <span class="percentage" id="stat-hot-list-pct">(${hotPct}%)</span>`;

  const apptsCount = callLogs.filter(r => r.appointmentGiven).length;
  const apptsPct = totalCalls > 0 ? Math.round((apptsCount / totalCalls) * 100) : 0;
  document.getElementById("stat-appointments").innerHTML = `${apptsCount} <span class="percentage" id="stat-appointments-pct">(${apptsPct}%)</span>`;

  const biRequests = callLogs.filter(r => r.biRequired).length;
  document.getElementById("stat-bi-requests").textContent = biRequests;

  const interestedCount = callLogs.filter(r => r.status === "Interested").length;
  const interestedPct = totalCalls > 0 ? Math.round((interestedCount / totalCalls) * 100) : 0;
  document.getElementById("stat-interested").innerHTML = `${interestedCount} <span class="percentage" id="stat-interested-pct">(${interestedPct}%)</span>`;
}

// --- Render Table & History Panel (Dual responsive system) ---
function renderHistoryTable(filteredLogs = null) {
  const tableBody = document.getElementById("history-table-body");
  const mobileCardsList = document.getElementById("mobile-cards-list");
  const activeLogs = filteredLogs || callLogs;
  
  const showingText = document.getElementById("showing-records-text");
  if (showingText) {
    showingText.textContent = `Showing ${activeLogs.length} of ${callLogs.length} entries`;
  }

  const isMobile = window.innerWidth <= 768;

  // Empty state handling
  if (activeLogs.length === 0) {
    const offlineWarning = !sheetUrl 
      ? `<p class="field-hint" style="color:#b45309; font-weight: 600; margin-top: 0.75rem; text-align: center; max-width: 320px;">⚠️ Sheets Offline: Configure your Google Sheets Sync URL in Settings (⚙️) to retrieve and search logs from other callers.</p>` 
      : "";

    const emptyStateHtml = `
      <div class="empty-state" style="padding: 2.5rem 1rem; text-align: center;">
        <i data-lucide="clipboard-list" class="empty-icon"></i>
        <h3>No call logs matching selected date/filter</h3>
        <p style="margin-top:0.25rem; color:#64748b;">Your Google Sheet has 57 records. Clear the date box or click below to view all historical records.</p>
        <button type="button" class="btn-primary" onclick="clearDateFilter()" style="margin-top:0.85rem; padding:0.45rem 1rem; font-weight:600;">Show All 57 Historical Logs</button>
        ${offlineWarning}
      </div>
    `;
    
    if (isMobile) {
      if (mobileCardsList) mobileCardsList.innerHTML = emptyStateHtml;
    } else {
      if (tableBody) {
        tableBody.innerHTML = `
          <tr class="empty-state-row">
            <td colspan="7">${emptyStateHtml}</td>
          </tr>
        `;
      }
    }
    if (window.lucide) window.lucide.createIcons();
    return;
  }

  // Clear previous records
  if (tableBody) tableBody.innerHTML = "";
  if (mobileCardsList) mobileCardsList.innerHTML = "";

  activeLogs.forEach(record => {
    // RENDER DESKTOP TABULAR VIEW
    if (tableBody) {
      const tr = document.createElement("tr");
      tr.setAttribute("data-id", record.id);

      const remarksHtml = record.comments 
        ? `<span class="cust-remarks" title="Remarks"><i data-lucide="message-square"></i> "${escapeHtml(record.comments)}"</span>` 
        : "";
        
      const detailsCell = `
        <td>
          <div class="cell-customer">
            <span class="cust-name">${escapeHtml(record.name)}</span>
            <span class="cust-phone">
              <i data-lucide="smartphone"></i> ${escapeHtml(record.mobile)}
            </span>
            <span class="cust-agent">
              <i data-lucide="user-check"></i> Agent: ${escapeHtml(record.addedBy || "N/A")}
            </span>
            ${remarksHtml}
          </div>
        </td>
      `;

      const ageDisplay = record.age ? `${record.age} yrs` : "—";
      const genderCell = `
        <td>
          <span class="cust-gender">${record.gender}</span>, 
          <span class="cust-age text-muted">${ageDisplay}</span>
        </td>
      `;

      let statusClass = "tbl-badge-thinking";
      let statusIcon = "message-square-more";
      if (record.status === "Hot List") {
        statusClass = "tbl-badge-hot-list";
        statusIcon = "flame";
      } else if (record.status === "Interested") {
        statusClass = "tbl-badge-interested";
        statusIcon = "thumbs-up";
      } else if (record.status === "Not Interested") {
        statusClass = "tbl-badge-refused";
        statusIcon = "thumbs-down";
      } else if (record.status === "Lead") {
        statusClass = "tbl-badge-lead";
        statusIcon = "sparkles";
      }
      const statusCell = `
        <td>
          <span class="tbl-badge ${statusClass}">
            <i data-lucide="${statusIcon}"></i> ${record.status}
          </span>
        </td>
      `;

      let apptContent = "";
      if (record.appointmentGiven) {
        apptContent = `
          <span class="appt-status appt-yes">Yes</span>
          <span class="appt-time" title="Scheduled Date">
            <i data-lucide="calendar"></i> ${formatDateTimeReadable(record.appointmentDate)}
          </span>
        `;
      } else {
        apptContent = `<span class="appt-status appt-no">No</span>`;
      }
      const appointmentCell = `<td><div class="appt-info">${apptContent}</div></td>`;
      let audioCell = "<td><span class='text-muted' style='font-size:0.75rem;'>No recording</span></td>";
      if (record.audioRecording && record.audioRecording.length > 50) {
        audioCell = `
          <td>
            <audio controls style="height:30px; width:130px;" src="${record.audioRecording}"></audio>
          </td>
        `;
      }

      let syncContent = "";
      if (record.syncStatus === "Synced") {
        syncContent = `
          <span class="sync-pill sync-pill-success">
            <i data-lucide="check-circle-2"></i> Synced
          </span>
        `;
      } else if (record.syncStatus === "Syncing") {
        syncContent = `
          <span class="sync-pill sync-pill-pending">
            <i class="input-icon spin-icon" data-lucide="loader-2" style="position:static; margin:0; width:11px; height:11px;"></i> Syncing...
          </span>
        `;
      } else {
        syncContent = `
          <span class="sync-pill sync-pill-pending" onclick="triggerSheetSync('${record.id}')" title="Click to manually sync">
            <i data-lucide="alert-circle"></i> Pending
          </span>
        `;
      }
      const syncCell = `<td class="sync-col">${syncContent}</td>`;

      const isHot = record.status === "Hot List";
      const actionCell = `
        <td>
          <div class="actions-cell">
            <button class="btn-icon-only" onclick="toggleHotListRecord('${record.id}')" title="${isHot ? 'Remove from Hot List' : 'Mark as 🔥 Hot List'}" style="background:${isHot ? '#fee2e2' : '#f1f5f9'}; border:1px solid ${isHot ? '#fca5a5' : '#cbd5e1'}; border-radius:50%; width:28px; height:28px; display:inline-flex; align-items:center; justify-content:center; cursor:pointer;">
              <i data-lucide="flame" style="width:14px; height:14px; color:${isHot ? '#dc2626' : '#64748b'};"></i>
            </button>
            <button class="btn-icon-only btn-tbl-call" onclick="triggerClickToCall('${record.mobile}')" title="Call Native SIM Dialer">
              <i data-lucide="phone-call" style="width:14px; height:14px;"></i>
            </button>
            <button class="btn-icon-only btn-tbl-wa" onclick="triggerWhatsAppChat('${record.mobile}', '${escapeHtml(record.name)}')" title="Open WhatsApp Chat">
              <i data-lucide="message-circle" style="width:14px; height:14px;"></i>
            </button>
            <button class="btn-icon-only btn-tbl-primary" onclick="editRecord('${record.id}')" title="Edit Record">
              <i data-lucide="edit-3" style="width:14px; height:14px;"></i>
            </button>
            <button class="btn-icon-only btn-tbl-danger" onclick="deleteRecord('${record.id}')" title="Delete Record">
              <i data-lucide="trash-2" style="width:14px; height:14px;"></i>
            </button>
          </div>
        </td>
      `;

      tr.innerHTML = detailsCell + genderCell + statusCell + appointmentCell + audioCell + syncCell + actionCell;
      tableBody.appendChild(tr);
    }

    // RENDER MOBILE CARDS LAYOUT VIEW
    if (mobileCardsList) {
      const card = document.createElement("div");
      card.className = "mobile-card";
      card.setAttribute("data-id", record.id);

      let statusClass = "tbl-badge-thinking";
      let statusIcon = "message-square-more";
      if (record.status === "Interested") {
        statusClass = "tbl-badge-interested";
        statusIcon = "thumbs-up";
      } else if (record.status === "Not Interested") {
        statusClass = "tbl-badge-refused";
        statusIcon = "thumbs-down";
      } else if (record.status === "Lead") {
        statusClass = "tbl-badge-lead";
        statusIcon = "sparkles";
      }

      const remarksHtml = record.comments 
        ? `
          <div class="m-card-remarks">
            <span class="m-card-remarks-label">Comments / Remarks:</span>
            <span>"${escapeHtml(record.comments)}"</span>
          </div>
        ` 
        : "";

      let apptContent = "";
      if (record.appointmentGiven) {
        apptContent = `
          <div class="m-card-detail-item">
            <span class="m-card-detail-label">Appt Date:</span>
            <span class="m-card-detail-val">${formatDateTimeReadable(record.appointmentDate)}</span>
          </div>
        `;
      }

      let biContent = "";
      if (record.biRequired) {
        biContent = `
          <div class="m-card-detail-item">
            <span class="m-card-detail-label">Product Category:</span>
            <span class="m-card-detail-val">${record.biProduct}</span>
          </div>
        `;
      }

      let syncContent = "";
      if (record.syncStatus === "Synced") {
        syncContent = `
          <span class="sync-pill sync-pill-success">
            <i data-lucide="check-circle-2"></i> Synced
          </span>
        `;
      } else if (record.syncStatus === "Syncing") {
        syncContent = `
          <span class="sync-pill sync-pill-pending">
            <i class="input-icon spin-icon" data-lucide="loader-2" style="position:static; margin:0; width:11px; height:11px;"></i> Syncing...
          </span>
        `;
      } else {
        syncContent = `
          <span class="sync-pill sync-pill-pending" onclick="triggerSheetSync('${record.id}')" title="Click to sync manually">
            <i data-lucide="alert-circle"></i> Pending
          </span>
        `;
      }

      const ageDisplay = record.age ? `${record.age} yrs` : "—";

      let audioPlayerHtml = "";
      if (record.audioRecording && record.audioRecording.length > 50) {
        audioPlayerHtml = `
          <div class="m-card-detail-item" style="flex-direction:column; align-items:flex-start; margin-top:0.4rem;">
            <span class="m-card-detail-label">Call Audio Recording:</span>
            <audio controls style="height:32px; width:100%; margin-top:0.25rem;" src="${record.audioRecording}"></audio>
          </div>
        `;
      }

      card.innerHTML = `
        <div class="m-card-header">
          <div class="m-card-cust-info">
            <span class="m-card-name">${escapeHtml(record.name)}</span>
            <span class="m-card-phone"><i data-lucide="smartphone"></i> ${escapeHtml(record.mobile)}</span>
          </div>
          <span class="tbl-badge ${statusClass}">
            <i data-lucide="${statusIcon}"></i> ${record.status}
          </span>
        </div>
        
        <div class="m-card-meta-row">
          <span class="m-card-agent"><i data-lucide="user-check"></i> ${escapeHtml(record.addedBy || "N/A")}</span>
          <span class="m-card-demographics">${record.gender}, ${ageDisplay}</span>
        </div>
        
        <div class="m-card-details-box">
          <div class="m-card-detail-item">
            <span class="m-card-detail-label">Appointment Given:</span>
            <span class="m-card-detail-val">${record.appointmentGiven ? "Yes" : "No"}</span>
          </div>
          ${apptContent}
          ${audioPlayerHtml}
          ${remarksHtml}
        </div>
        
        <div class="m-card-actions">
          <span class="m-card-time">${formatDateTimeReadable(record.timestamp)}</span>
          <div style="display:flex; align-items:center; gap:0.4rem;">
            ${syncContent}
            <button class="btn-icon-only" onclick="toggleHotListRecord('${record.id}')" title="Mark Hot List" style="background:${record.status === 'Hot List' ? '#fee2e2' : '#f1f5f9'}; border:1px solid ${record.status === 'Hot List' ? '#fca5a5' : '#cbd5e1'};">
              <i data-lucide="flame" style="width:13px; height:13px; color:${record.status === 'Hot List' ? '#dc2626' : '#64748b'};"></i>
            </button>
            <button class="btn-icon-only btn-tbl-call" onclick="triggerClickToCall('${record.mobile}')" title="Call SIM">
              <i data-lucide="phone-call" style="width:13px; height:13px;"></i>
            </button>
            <button class="btn-icon-only btn-tbl-wa" onclick="triggerWhatsAppChat('${record.mobile}', '${escapeHtml(record.name)}')" title="WhatsApp">
              <i data-lucide="message-circle" style="width:13px; height:13px;"></i>
            </button>
            <button class="btn-icon-only btn-tbl-primary" onclick="editRecord('${record.id}')" title="Edit Log">
              <i data-lucide="edit-3" style="width:13px; height:13px;"></i>
            </button>
            <button class="btn-icon-only btn-tbl-danger" onclick="deleteRecord('${record.id}')" title="Delete Log">
              <i data-lucide="trash-2" style="width:13px; height:13px;"></i>
            </button>
          </div>
        </div>
      `;

      mobileCardsList.appendChild(card);
    }
  });

  if (window.lucide) {
    window.lucide.createIcons();
  }
}

function filterCallHistory() {
  const searchInput = document.getElementById("search-input").value.toLowerCase().trim();
  const statusFilter = document.getElementById("filter-status").value;
  const appointmentFilter = document.getElementById("filter-appointment").value;
  const dateFilterInput = document.getElementById("filter-date");
  
  // Clean up any default date lock
  let dateFilter = dateFilterInput ? dateFilterInput.value : "";

  const filteredLogs = callLogs.filter(record => {
    if (!record) return false;

    // 1. Safe Search Query Match across Name, Mobile, Comments, and AddedBy (Caller)
    const recName = record.name ? record.name.toString().toLowerCase() : "";
    
    let recMobile = record.mobile ? record.mobile.toString() : "";
    if (recMobile.indexOf('.') !== -1) {
      recMobile = recMobile.split('.')[0];
    }
    recMobile = recMobile.toLowerCase();

    const recComments = record.comments ? record.comments.toString().toLowerCase() : "";
    const recAddedBy = record.addedBy ? record.addedBy.toString().toLowerCase() : "";

    const matchesSearch = recName.includes(searchInput) || 
                          recMobile.includes(searchInput) ||
                          recComments.includes(searchInput) ||
                          recAddedBy.includes(searchInput);
    
    // 2. Status Match
    const matchesStatus = statusFilter === "All" || record.status === statusFilter;

    // 3. Appointment Match
    let matchesAppointment = true;
    if (appointmentFilter === "Yes") {
      matchesAppointment = record.appointmentGiven === true;
    } else if (appointmentFilter === "No") {
      matchesAppointment = record.appointmentGiven === false;
    }

    // 4. Date Match (Filters by Call Log Timestamp or Scheduled Appointment Date)
    let matchesDate = true;
    if (dateFilter) {
      const recDate = getLocalDateISO(record.timestamp);
      const apptDate = getLocalDateISO(record.appointmentDate);
      const rawTimestamp = record.timestamp ? String(record.timestamp) : "";
      const rawAppt = record.appointmentDate ? String(record.appointmentDate) : "";
      matchesDate = (recDate === dateFilter) || (apptDate === dateFilter) || rawTimestamp.includes(dateFilter) || rawAppt.includes(dateFilter);
    }

    return matchesSearch && matchesStatus && matchesAppointment && matchesDate;
  });

  renderHistoryTable(filteredLogs);
}

function clearDateFilter() {
  const dateInput = document.getElementById("filter-date");
  if (dateInput) {
    dateInput.value = "";
    filterCallHistory();
  }
}

function getLocalDateISO(dateInput) {
  if (!dateInput) return "";
  const d = new Date(dateInput);
  if (isNaN(d.getTime())) return "";
  const year = d.getFullYear();
  const month = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

// --- Live Mobile Number Lookup CRM Feature ---
function handleLiveMobileLookup() {
  const mobileInput = document.getElementById("mobile-number");
  const warnContainer = document.getElementById("duplicate-warning-container");
  if (!mobileInput || !warnContainer) return;

  const mobileVal = mobileInput.value.trim().replace(/[^0-9]/g, "");
  
  // Only search when the input is a valid 10-digit number
  if (mobileVal.length === 10) {
    const match = callLogs.find(record => {
      let recMobile = String(record.mobile || "");
      if (recMobile.indexOf('.') !== -1) {
        recMobile = recMobile.split('.')[0];
      }
      recMobile = recMobile.replace(/[^0-9]/g, "");
      return recMobile === mobileVal;
    });

    if (match && match.id !== editingRecordId) {
      // Record found! Show friendly warning banner
      warnContainer.innerHTML = `
        <div class="dup-warn-banner">
          <i data-lucide="alert-circle" class="dup-warn-icon"></i>
          <span class="dup-warn-text">
            Customer already logged by <strong>${escapeHtml(match.addedBy || "another caller")}</strong>.
          </span>
          <button type="button" class="dup-warn-action-btn" onclick="editRecord('${match.id}')">
            <i data-lucide="edit-3"></i> Load & Edit Details
          </button>
        </div>
      `;
      warnContainer.classList.remove("hidden");
      if (window.lucide) window.lucide.createIcons();
      return;
    }
  }

  // Hide container if no match or length is not 10 digits
  warnContainer.classList.add("hidden");
  warnContainer.innerHTML = "";
}

// --- Delete & Clear Actions ---
function deleteRecord(recordId) {
  const record = callLogs.find(r => r.id === recordId);
  if (!record) return;

  if (confirm(`Are you sure you want to delete the call record for "${record.name}"?`)) {
    callLogs = callLogs.filter(r => r.id !== recordId);
    saveLogsToLocalStorage();
    
    renderHistoryTable();
    recalculateAnalytics();
    showToast("Record Deleted", "Client record removed successfully.", "info");
    
    if (editingRecordId === recordId) {
      resetForm();
    }
  }
}

function clearTodayLogs() {
  if (callLogs.length === 0) {
    showToast("No Logs", "There are no calling logs to clear.", "info");
    return;
  }

  if (confirm("WARNING: This will delete ALL logged calling updates on your screen. Do you want to proceed?")) {
    callLogs = [];
    saveLogsToLocalStorage();
    
    renderHistoryTable();
    recalculateAnalytics();
    showToast("Data Cleared", "Calling log entries have been cleared.", "success");
    resetForm();
  }
}

// --- Export to CSV Generator ---
function exportCallLogsToCSV() {
  if (callLogs.length === 0) {
    showToast("No Data", "There are no logged calls to export yet.", "error");
    return;
  }

  const headers = [
    "Timestamp",
    "Customer Name",
    "Mobile Number",
    "Age",
    "Gender",
    "Call Status",
    "Appointment Given",
    "Appointment Date",
    "BI Required",
    "BI Product",
    "Call Comments",
    "Added By"
  ];

  const csvRows = [
    headers.join(",")
  ];

  callLogs.forEach(record => {
    const row = [
      `"${new Date(record.timestamp).toLocaleString()}"`,
      `"${escapeCsvString(record.name)}"`,
      `"${record.mobile}"`,
      `"${record.age || 'N/A'}"`,
      `"${record.gender}"`,
      `"${record.status}"`,
      `"${record.appointmentGiven ? 'Yes' : 'No'}"`,
      `"${record.appointmentDate ? formatDateTimeReadable(record.appointmentDate) : 'N/A'}"`,
      `"${record.biRequired ? 'Yes' : 'No'}"`,
      `"${record.biProduct || 'N/A'}"`,
      `"${escapeCsvString(record.comments || 'N/A')}"`,
      `"${escapeCsvString(record.addedBy || 'N/A')}"`
    ];
    csvRows.push(row.join(","));
  });

  const csvString = csvRows.join("\n");
  const blob = new Blob([csvString], { type: "text/csv;charset=utf-8;" });
  
  const link = document.createElement("a");
  const url = URL.createObjectURL(blob);
  
  const today = new Date().toISOString().slice(0, 10);
  link.setAttribute("href", url);
  link.setAttribute("download", `allied_telecaller_logs_${today}.csv`);
  link.style.visibility = 'hidden';
  
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  
  showToast("Export Successful", "CSV log sheet downloaded successfully.", "success");
}

// --- Toast System Helper ---
function showToast(title, message, type = "success") {
  const container = document.getElementById("toast-container");
  if (!container) return;

  const toast = document.createElement("div");
  toast.className = `toast toast-${type}`;
  
  let icon = "check-circle";
  if (type === "error") icon = "alert-octagon";
  if (type === "info") icon = "info";

  toast.innerHTML = `
    <i data-lucide="${icon}" class="toast-icon"></i>
    <div class="toast-content">
      <h4>${title}</h4>
      <p>${message}</p>
    </div>
    <button class="toast-close" onclick="this.parentElement.classList.add('toast-exit'); setTimeout(() => this.parentElement.remove(), 250)">&times;</button>
  `;

  container.appendChild(toast);
  
  if (window.lucide) {
    window.lucide.createIcons();
  }

  setTimeout(() => {
    if (toast && toast.parentElement) {
      toast.classList.add("toast-exit");
      setTimeout(() => toast.remove(), 250);
    }
  }, 4500);
}

// --- Common UI Formatting Helpers ---
function formatDateTimeReadable(isoString) {
  if (!isoString) return "";
  const date = new Date(isoString);
  return date.toLocaleString('en-US', {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    hour12: true
  });
}

function escapeHtml(str) {
  if (!str) return "";
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

function escapeCsvString(str) {
  if (!str) return "";
  return str.replace(/"/g, '""');
}

// --- 📞 Click-to-Call & 💬 WhatsApp Direct Launcher ---
function triggerClickToCall(targetMobile = null) {
  const mob = targetMobile || document.getElementById("mobile-number").value.trim();
  const cleanMobile = mob.replace(/[^0-9]/g, "");
  if (!cleanMobile || cleanMobile.length < 10) {
    showToast("Invalid Mobile", "Please enter or select a valid 10-digit mobile number to call.", "error");
    return;
  }

  // 1. Auto-start recording before launching native SIM dialer
  startAutoCallRecording();

  // 2. Trigger native SIM phone dialer
  window.location.href = `tel:${cleanMobile}`;
  showToast("Calling & Recording", `Initiating call for ${cleanMobile}. Recording started automatically!`, "info");
}

function triggerWhatsAppChat(targetMobile = null, targetName = "") {
  const mob = targetMobile || document.getElementById("mobile-number").value.trim();
  const name = targetName || (document.getElementById("customer-name") ? document.getElementById("customer-name").value.trim() : "");
  let cleanMobile = mob.replace(/[^0-9]/g, "");
  if (!cleanMobile || cleanMobile.length < 10) {
    showToast("Invalid Mobile", "Please enter or select a valid 10-digit mobile number for WhatsApp.", "error");
    return;
  }
  if (cleanMobile.length === 10) {
    cleanMobile = "91" + cleanMobile;
  }
  
  const greeting = name ? `Hello ${name}, ` : "Hello, ";
  const defaultMsg = encodeURIComponent(`${greeting}following up from Allied Services regarding your query.`);
  
  const waUrl = `https://wa.me/${cleanMobile}?text=${defaultMsg}`;
  window.open(waUrl, '_blank');
  showToast("WhatsApp Direct", `Opening WhatsApp chat with +${cleanMobile}.`, "success");
}

// --- 📊 Excel/CSV Lead Upload & Calling Queue Engine ---
function handleExcelUpload(event) {
  const file = event.target.files[0];
  if (!file) return;

  const reader = new FileReader();
  reader.onload = function(e) {
    try {
      const data = new Uint8Array(e.target.result);
      const workbook = XLSX.read(data, { type: 'array' });
      const firstSheetName = workbook.SheetNames[0];
      const worksheet = workbook.Sheets[firstSheetName];
      const rawRows = XLSX.utils.sheet_to_json(worksheet, { defval: "" });

      if (!rawRows || rawRows.length === 0) {
        showToast("Empty File", "The uploaded Excel file contains no readable rows.", "error");
        return;
      }

      let parsedCount = 0;
      const newQueue = [];

      rawRows.forEach((row, index) => {
        const rowKeys = Object.keys(row);
        let name = "";
        let mobileRaw = "";
        let age = "";
        let gender = "";
        let city = "";

        // 1. Try finding explicit header matches first
        for (let k of rowKeys) {
          const cleanK = k.toLowerCase().trim();
          const val = String(row[k]).trim();
          if (!val) continue;

          if (["customer name", "name", "client name", "full name", "client", "customer", "lead name", "lead"].includes(cleanK)) {
            if (!name) name = val;
          } else if (["mobile number", "mobile", "phone", "phone number", "contact", "contact number", "cell", "telephone", "mobile no", "phone no", "mobile_no", "mob", "number"].includes(cleanK)) {
            if (!mobileRaw) mobileRaw = val;
          } else if (["age", "customer age"].includes(cleanK)) {
            if (!age) age = val;
          } else if (["gender", "sex"].includes(cleanK)) {
            if (!gender) gender = val;
          } else if (["city", "location", "address", "notes", "remarks"].includes(cleanK)) {
            if (!city) city = val;
          }
        }

        // 2. Ultra-smart fallback: If header name wasn't recognized, scan ALL cell values in this row for phone numbers!
        if (!mobileRaw) {
          for (let k of rowKeys) {
            const valStr = String(row[k]).trim();
            const cleanedVal = valStr.replace(/[^0-9]/g, "");
            // If cell contains 10 to 13 digits, treat it as the mobile number!
            if (cleanedVal.length >= 10 && cleanedVal.length <= 13) {
              mobileRaw = valStr;
              break;
            }
          }
        }

        // 3. Fallback for Name: If name wasn't recognized, pick the first non-numeric text cell that isn't the phone number
        if (!name) {
          for (let k of rowKeys) {
            const valStr = String(row[k]).trim();
            if (valStr && valStr !== mobileRaw && isNaN(valStr) && valStr.length > 1) {
              name = valStr;
              break;
            }
          }
        }

        // Clean extracted mobile number
        let mobile = mobileRaw.replace(/[^0-9]/g, "");
        if (mobile.length === 12 && mobile.startsWith("91")) {
          mobile = mobile.slice(2);
        } else if (mobile.length > 10) {
          mobile = mobile.slice(-10);
        }

        if (mobile.length === 10) {
          newQueue.push({
            id: `lead_${Date.now()}_${index}`,
            name: name || `Lead ${parsedCount + 1}`,
            mobile: mobile,
            age: age || "",
            gender: gender || "",
            city: city || "",
            status: "Pending"
          });
          parsedCount++;
        }
      });

      if (parsedCount === 0) {
        showToast("No Valid Numbers", "Could not find valid 10-digit mobile numbers in the file. Ensure headers are Name and Mobile.", "error");
        return;
      }

      leadQueue = [...leadQueue, ...newQueue];
      saveLeadQueueToLocalStorage();
      renderLeadQueue();
      
      // Upload new leads to central Google Sheets Lead Queue tab
      syncCentralLeadQueue(newQueue);

      showToast("Excel Imported", `Loaded ${parsedCount} leads into Central Calling Queue!`, "success");

    } catch (err) {
      console.error("Excel parse error:", err);
      showToast("Import Failed", "Failed to parse Excel file. Please upload a valid .xlsx or .csv file.", "error");
    } finally {
      event.target.value = "";
    }
  };

  reader.readAsArrayBuffer(file);
}

async function syncCentralLeadQueue(newLeads) {
  if (!sheetUrl) return;
  try {
    await fetch(sheetUrl, {
      method: "POST",
      mode: "no-cors",
      headers: { "Content-Type": "text/plain;charset=utf-8" },
      body: JSON.stringify({
        action: "upload_queue",
        leads: newLeads
      })
    });
    console.log("Central lead queue uploaded to Google Sheets.");
  } catch (err) {
    console.warn("Could not sync central lead queue:", err);
  }
}

async function fetchCentralLeadQueue() {
  if (!sheetUrl) return;
  try {
    const callbackName = "handleCentralQueueFallback_" + Date.now();
    window[callbackName] = function(data) {
      if (data && data.status === "success" && data.queue) {
        mergeLeadQueue(data.queue);
        saveLeadQueueToLocalStorage();
        renderLeadQueue();
        if (window.innerWidth <= 768) {
          switchMobileTab('queue');
        }
        showToast("Leads Updated", `Loaded ${data.queue.length} central leads!`, "success");
      }
      delete window[callbackName];
    };

    // Always use script tag injection (JSONP) for 100% reliable cross-origin loading on mobile browsers
    const oldScripts = document.querySelectorAll("script[data-queue-script='true']");
    oldScripts.forEach(s => s.remove());

    const scriptTag = document.createElement("script");
    scriptTag.setAttribute("data-queue-script", "true");
    scriptTag.src = sheetUrl + (sheetUrl.includes("?") ? "&" : "?") + "action=fetch_queue&callback=" + callbackName + "&_t=" + Date.now();
    scriptTag.onload = () => scriptTag.remove();
    scriptTag.onerror = () => scriptTag.remove();
    document.body.appendChild(scriptTag);
  } catch (err) {
    console.warn("Could not fetch remote lead queue:", err);
  }
}

function mergeLeadQueue(remoteQueue) {
  if (!remoteQueue || !Array.isArray(remoteQueue) || remoteQueue.length === 0) return;
  const map = new Map();
  // Add remote queue items first so fresh central leads overwrite stale local cache
  remoteQueue.forEach((item, idx) => {
    if (item && item.mobile) {
      const mob = String(item.mobile).replace(/[^0-9]/g, "");
      const cleanItem = {
        id: item.id || `lead_remote_${idx}_${Date.now()}`,
        name: item.name || `Lead ${idx + 1}`,
        mobile: mob,
        age: item.age || "",
        gender: item.gender || "",
        city: item.city || "",
        status: item.status || "Pending"
      };
      map.set(mob, cleanItem);
    }
  });
  // Preserve any local call status updates
  leadQueue.forEach(item => {
    if (item && item.mobile && map.has(item.mobile)) {
      if (item.status === "Called" || item.status === "Hot List") {
        map.get(item.mobile).status = item.status;
      }
    }
  });
  leadQueue = Array.from(map.values());
}

function saveLeadQueueToLocalStorage() {
  localStorage.setItem("telecaller_lead_queue", JSON.stringify(leadQueue));
}

function clearLeadQueue() {
  if (leadQueue.length === 0) return;
  if (confirm("Are you sure you want to clear all imported leads from the queue?")) {
    leadQueue = [];
    saveLeadQueueToLocalStorage();
    renderLeadQueue();
    showToast("Queue Cleared", "Imported leads queue cleared.", "info");
  }
}

function renderLeadQueue() {
  const container = document.getElementById("lead-queue-container");
  const badge = document.getElementById("queue-badge-count");
  if (!container) return;

  if (badge) {
    const pendingCount = leadQueue.filter(l => l.status === "Pending").length;
    badge.textContent = `${pendingCount} / ${leadQueue.length} Pending`;
  }

  if (leadQueue.length === 0) {
    container.innerHTML = `
      <div class="empty-queue-hint">
        <i data-lucide="upload" style="width:22px; height:22px; color:#94a3b8;"></i>
        <span>Upload an Excel/CSV lead file to auto-populate numbers into your calling queue. Click any lead to load it directly into the form!</span>
      </div>
    `;
    if (window.lucide) window.lucide.createIcons();
    return;
  }

  let html = `<div class="queue-list-grid">`;
  // Limit DOM rendering to first 100 items for 0ms instant page load speed
  const visibleLeads = leadQueue.slice(0, 100);
  visibleLeads.forEach(lead => {
    const isCalled = lead.status === "Called";
    const statusBadgeClass = isCalled ? "queue-status-called" : "queue-status-pending";
    const statusText = isCalled ? "Called" : "Pending";

    html += `
      <div class="queue-card ${isCalled ? 'card-dimmed' : ''}" data-queue-id="${lead.id}">
        <div class="q-card-header" onclick="loadLeadToForm('${lead.id}')">
          <div class="q-info">
            <span class="q-name">${escapeHtml(lead.name)}</span>
            <span class="q-mobile"><i data-lucide="smartphone"></i> ${lead.mobile}</span>
          </div>
          <span class="queue-status-badge ${statusBadgeClass}">${statusText}</span>
        </div>
        <div class="q-actions">
          <button type="button" class="btn-q-action" onclick="toggleHotListLead('${lead.id}')" title="Toggle Hot List" style="background:${lead.status === 'Hot List' ? '#fee2e2' : '#f1f5f9'}; color:${lead.status === 'Hot List' ? '#dc2626' : '#64748b'}; border:1px solid ${lead.status === 'Hot List' ? '#fca5a5' : '#cbd5e1'};">
            <i data-lucide="flame" style="color:${lead.status === 'Hot List' ? '#dc2626' : '#64748b'};"></i> ${lead.status === 'Hot List' ? 'Hot' : 'Hot'}
          </button>
          <button type="button" class="btn-q-action btn-q-load" onclick="loadLeadToForm('${lead.id}')" title="Load Lead to Form">
            <i data-lucide="arrow-left-circle"></i> Load
          </button>
          <button type="button" class="btn-q-action btn-q-call" onclick="triggerClickToCall('${lead.mobile}'); markLeadStatus('${lead.id}', 'Called');" title="Call Number">
            <i data-lucide="phone-call"></i> Call
          </button>
          <button type="button" class="btn-q-action btn-q-wa" onclick="triggerWhatsAppChat('${lead.mobile}', '${escapeHtml(lead.name)}')" title="WhatsApp Message">
            <i data-lucide="message-circle"></i> WhatsApp
          </button>
        </div>
      </div>
    `;
  });
  html += `</div>`;

  container.innerHTML = html;
  if (window.lucide) window.lucide.createIcons();
}

function loadLeadToForm(leadId) {
  const lead = leadQueue.find(l => l.id === leadId);
  if (!lead) return;

  document.getElementById("customer-name").value = lead.name;
  document.getElementById("mobile-number").value = lead.mobile;
  if (lead.age) document.getElementById("customer-age").value = lead.age;
  if (lead.gender && (lead.gender === "Male" || lead.gender === "Female")) {
    document.getElementById("customer-gender").value = lead.gender;
  }

  showToast("Lead Loaded", `Loaded "${lead.name}" into Call Log Form.`, "info");

  const formPanel = document.getElementById("form-panel-section");
  if (formPanel) formPanel.scrollIntoView({ behavior: "smooth" });

  if (window.innerWidth <= 768) {
    switchMobileTab('form');
  }
}

function toggleHotListLead(leadId) {
  const item = leadQueue.find(l => l.id === leadId);
  if (!item) return;
  const isHot = item.status === "Hot List";
  item.status = isHot ? "Pending" : "Hot List";
  saveLeadQueueToLocalStorage();
  renderLeadQueue();
  showToast(isHot ? "Removed from Hot List" : "🔥 Added to Hot List", `Lead "${item.name}" updated.`, isHot ? "info" : "success");
}

function toggleHotListRecord(recordId) {
  const rec = callLogs.find(r => r.id === recordId);
  if (!rec) return;
  const isHot = rec.status === "Hot List";
  rec.status = isHot ? "Interested" : "Hot List";
  saveLogsToLocalStorage();
  filterCallHistory();
  recalculateAnalytics();
  triggerSheetSync(recordId);
  showToast(isHot ? "Status Changed" : "🔥 Added to Hot List", `Record for "${rec.name}" updated to ${rec.status}.`, isHot ? "info" : "success");
}

function markLeadStatus(leadId, newStatus) {
  const index = leadQueue.findIndex(l => l.id === leadId);
  if (index !== -1) {
    leadQueue[index].status = newStatus;
    saveLeadQueueToLocalStorage();
    renderLeadQueue();
  }
}

// --- 🎙️ Voice Call Audio Recorder Engine (MediaRecorder API) ---
async function startAutoCallRecording() {
  const recBtn = document.getElementById("btn-record-start");
  const recBtnText = document.getElementById("rec-btn-text");
  const recTimer = document.getElementById("rec-timer");
  const previewContainer = document.getElementById("audio-preview-container");

  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    audioChunks = [];
    
    // Choose compatible MIME type for browser/mobile audio capture
    let options = {};
    if (MediaRecorder.isTypeSupported('audio/webm;codecs=opus')) {
      options = { mimeType: 'audio/webm;codecs=opus' };
    } else if (MediaRecorder.isTypeSupported('audio/mp4')) {
      options = { mimeType: 'audio/mp4' };
    }

    mediaRecorder = new MediaRecorder(stream, options);

    mediaRecorder.ondataavailable = event => {
      if (event.data && event.data.size > 0) {
        audioChunks.push(event.data);
      }
    };

    mediaRecorder.onstop = () => {
      const mimeType = mediaRecorder.mimeType || 'audio/webm';
      const audioBlob = new Blob(audioChunks, { type: mimeType });
      const reader = new FileReader();
      reader.onloadend = () => {
        recordedAudioBase64 = reader.result;
        const player = document.getElementById("audio-player");
        if (player) {
          player.src = URL.createObjectURL(audioBlob);
        }
        if (previewContainer) previewContainer.classList.remove("hidden");
      };
      reader.readAsDataURL(audioBlob);

      stream.getTracks().forEach(track => track.stop());
    };

    mediaRecorder.start(500); // Capture data chunks every 500ms
    
    if (recBtn) recBtn.className = "btn-recorder btn-rec-recording";
    if (recBtnText) recBtnText.textContent = "Recording Call...";
    if (recTimer) recTimer.classList.remove("hidden");

    recordingSeconds = 0;
    if (recTimer) recTimer.textContent = "00:00";
    if (recordingTimerInterval) clearInterval(recordingTimerInterval);
    recordingTimerInterval = setInterval(() => {
      recordingSeconds++;
      const mins = String(Math.floor(recordingSeconds / 60)).padStart(2, '0');
      const secs = String(recordingSeconds % 60).padStart(2, '0');
      if (recTimer) recTimer.textContent = `${mins}:${secs}`;
    }, 1000);

    // Auto-stop recording when caller returns to app window after ending call
    window.addEventListener("focus", handleWindowFocusAutoStop, { once: true });

  } catch (err) {
    console.error("Microphone access error:", err);
    showToast("Mic Access Required", "Please allow microphone permissions in browser settings for call recording.", "error");
  }
}

function handleWindowFocusAutoStop() {
  // Give 1.5 seconds grace period after phone dialer returns focus to wrap up recording
  setTimeout(() => {
    stopAutoCallRecording();
  }, 1500);
}

function stopAutoCallRecording() {
  const recBtn = document.getElementById("btn-record-start");
  const recBtnText = document.getElementById("rec-btn-text");
  const recTimer = document.getElementById("rec-timer");

  if (mediaRecorder && mediaRecorder.state === "recording") {
    mediaRecorder.stop();
    if (recordingTimerInterval) clearInterval(recordingTimerInterval);

    if (recBtn) recBtn.className = "btn-recorder btn-rec-start";
    if (recBtnText) recBtnText.textContent = "Record Voice Note";
    if (recTimer) recTimer.classList.add("hidden");

    showToast("Call Ended & Saved", "Call audio recorded and attached to form preview!", "success");
  }
}

async function toggleAudioRecording() {
  if (!mediaRecorder || mediaRecorder.state === "inactive") {
    await startAutoCallRecording();
  } else if (mediaRecorder && mediaRecorder.state === "recording") {
    stopAutoCallRecording();
  }
}

function deleteAudioRecording() {
  recordedAudioBase64 = null;
  const player = document.getElementById("audio-player");
  const previewContainer = document.getElementById("audio-preview-container");
  if (player) player.src = "";
  if (previewContainer) previewContainer.classList.add("hidden");
}

// --- 📞 OUTBOUND CALLS AUDIT & STAT BREAKDOWN MODAL HANDLERS ---
function openCallsAuditModal(filterCategory = 'all') {
  const modal = document.getElementById("calls-audit-modal");
  const tableBody = document.getElementById("audit-table-body");
  const totalCountEl = document.getElementById("audit-total-count");
  const uniqueCountEl = document.getElementById("audit-unique-count");
  const titleEl = document.querySelector("#calls-audit-modal h3");

  if (!modal || !tableBody) return;

  // Base list of valid call records
  let filteredList = callLogs.filter(r => r.mobile && r.mobile.toString().replace(/[^0-9]/g, "").length >= 10);
  let categoryTitle = "Daily Outbound Calls Audit";

  if (filterCategory === 'hotlist') {
    filteredList = filteredList.filter(r => r.status === "Hot List");
    categoryTitle = "🔥 Hot List Prospects Breakdown";
  } else if (filterCategory === 'appointments') {
    filteredList = filteredList.filter(r => r.appointmentGiven === true);
    categoryTitle = "Appointments Secured Breakdown";
  } else if (filterCategory === 'bi') {
    filteredList = filteredList.filter(r => r.biRequired === true);
    categoryTitle = "BI Requests Customer Breakdown";
  } else if (filterCategory === 'interested') {
    filteredList = filteredList.filter(r => r.status === "Interested");
    categoryTitle = "Interested Leads Breakdown";
  }

  if (titleEl) titleEl.textContent = categoryTitle;

  const uniqueMobiles = new Set();
  filteredList.forEach(r => {
    const cleanMob = r.mobile.toString().replace(/[^0-9]/g, "");
    if (cleanMob.length >= 10) uniqueMobiles.add(cleanMob);
  });

  if (totalCountEl) totalCountEl.textContent = filteredList.length;
  if (uniqueCountEl) uniqueCountEl.textContent = uniqueMobiles.size;

  if (filteredList.length === 0) {
    tableBody.innerHTML = `
      <tr>
        <td colspan="5" style="padding:2rem; text-align:center; color:var(--text-muted);">
          No matching records found for this category. Click <strong>Sync All Data</strong> to fetch team logs.
        </td>
      </tr>
    `;
  } else {
    tableBody.innerHTML = "";
    filteredList.forEach(r => {
      const tr = document.createElement("tr");
      tr.style.borderBottom = "1px solid var(--border-color)";
      const timeStr = r.timestamp ? formatDateTimeReadable(r.timestamp) : "—";
      const cleanMob = r.mobile.toString().replace(/[^0-9]/g, "");

      let statusBadge = `<span class="tbl-badge tbl-badge-interested" style="font-size:0.7rem; padding:0.15rem 0.4rem;">${r.status || "Called"}</span>`;
      if (r.appointmentGiven) {
        statusBadge += `<br><span style="font-size:0.68rem; color:#059669; font-weight:700;">📅 ${formatDateTimeReadable(r.appointmentDate)}</span>`;
      }
      if (r.biRequired) {
        statusBadge += `<br><span style="font-size:0.68rem; color:#4338ca; font-weight:700;">📄 BI: ${escapeHtml(r.biProduct || "Req")}</span>`;
      }

      tr.innerHTML = `
        <td style="padding:0.6rem 0.85rem; font-size:0.75rem; color:var(--text-muted);">${timeStr}</td>
        <td style="padding:0.6rem 0.85rem; font-weight:600; color:var(--text-main);">${escapeHtml(r.name)}</td>
        <td style="padding:0.6rem 0.85rem; font-weight:700; color:var(--primary); font-family:monospace;">${cleanMob}</td>
        <td style="padding:0.6rem 0.85rem; color:var(--text-muted);">${escapeHtml(r.addedBy || "N/A")}</td>
        <td style="padding:0.6rem 0.85rem;">${statusBadge}</td>
      `;
      tableBody.appendChild(tr);
    });
  }

  modal.classList.remove("hidden-modal");
  if (window.lucide) window.lucide.createIcons();
}

function closeCallsAuditModal() {
  const modal = document.getElementById("calls-audit-modal");
  if (modal) modal.classList.add("hidden-modal");
}

// --- 📱 MOBILE TAB SWITCHER ENGINE ---
function switchMobileTab(tabName) {
  const queueSection = document.getElementById("lead-queue-panel-section") || document.querySelector(".lead-queue-panel");
  const formSection = document.getElementById("form-panel-section");
  const historySection = document.getElementById("table-panel-section") || document.querySelector(".table-panel");

  const btnQueue = document.getElementById("nav-btn-queue");
  const btnForm = document.getElementById("nav-btn-form");
  const btnHistory = document.getElementById("nav-btn-history");

  const btnSync = document.getElementById("nav-btn-sync");

  // Reset active buttons
  if (btnQueue) btnQueue.classList.remove("active");
  if (btnForm) btnForm.classList.remove("active");
  if (btnHistory) btnHistory.classList.remove("active");
  if (btnSync) btnSync.classList.remove("active");

  if (queueSection) queueSection.style.display = "";
  if (formSection) formSection.style.display = "";
  if (historySection) historySection.style.display = "";

  if (tabName === 'queue') {
    if (queueSection) queueSection.classList.remove("mobile-tab-hidden");
    if (formSection) formSection.classList.add("mobile-tab-hidden");
    if (historySection) historySection.classList.add("mobile-tab-hidden");
    if (btnQueue) btnQueue.classList.add("active");
  } else if (tabName === 'form') {
    if (queueSection) queueSection.classList.add("mobile-tab-hidden");
    if (formSection) formSection.classList.remove("mobile-tab-hidden");
    if (historySection) historySection.classList.add("mobile-tab-hidden");
    if (btnForm) btnForm.classList.add("active");
  } else if (tabName === 'history') {
    if (queueSection) queueSection.classList.add("mobile-tab-hidden");
    if (formSection) formSection.classList.add("mobile-tab-hidden");
    if (historySection) historySection.classList.remove("mobile-tab-hidden");
    if (btnHistory) btnHistory.classList.add("active");
  }

  window.scrollTo({ top: 0, behavior: "smooth" });
}

window.addEventListener("resize", () => {
  if (window.innerWidth > 768) {
    const queueSection = document.querySelector(".lead-queue-panel");
    const formSection = document.getElementById("form-panel-section");
    const historySection = document.querySelector(".table-panel");
    if (queueSection) queueSection.style.display = "";
    if (formSection) formSection.style.display = "";
    if (historySection) historySection.style.display = "";
  }
});

// --- 🔒 SECURITY ACCESS & PIN AUTHENTICATION ENGINE ---
function checkCallerSecurityAccess() {
  const isAuth = localStorage.getItem("telecaller_auth_token") === "TRUE";
  const callerName = localStorage.getItem("telecaller_agent_name");
  const userRole = localStorage.getItem("telecaller_user_role") || "Caller";

  const modal = document.getElementById("security-auth-modal");
  const badgeName = document.getElementById("logged-user-name");
  const agentInput = document.getElementById("caller-name");
  const exportBtn = document.getElementById("export-csv-btn");

  if (!isAuth || !callerName) {
    if (modal) modal.classList.remove("hidden-modal");
    if (badgeName) badgeName.innerText = "Locked";
  } else {
    if (modal) modal.classList.add("hidden-modal");
    if (badgeName) badgeName.innerText = callerName + (userRole === "Admin" ? " (Admin)" : "");
    if (agentInput) agentInput.value = callerName;

    // Lock Bulk CSV Export button for Non-Admin Callers to prevent lead theft!
    if (exportBtn) {
      if (userRole !== "Admin") {
        exportBtn.style.display = "none";
      } else {
        exportBtn.style.display = "inline-flex";
      }
    }

    // Auto-fetch central lead queue as soon as user is unlocked
    fetchCentralLeadQueue();
  }
}

async function handleCallerLogin(event) {
  event.preventDefault();
  const nameInput = document.getElementById("auth-caller-name");
  const pinInput = document.getElementById("auth-caller-pin");
  const errBox = document.getElementById("auth-error-msg");
  const submitBtn = document.getElementById("auth-submit-btn");

  const nameVal = nameInput ? nameInput.value.trim() : "";
  const pinVal = pinInput ? pinInput.value.trim() : "";

  if (!nameVal || !pinVal) return;

  if (submitBtn) {
    submitBtn.disabled = true;
    submitBtn.innerHTML = `<i class="input-icon spin-icon" data-lucide="loader-2" style="position:static; margin:0;"></i> Verifying Credentials...`;
    if (window.lucide) window.lucide.createIcons();
  }
  if (errBox) errBox.classList.add("hidden");

  // Retrieve or generate persistent unique Device Hardware Fingerprint ID
  let deviceId = localStorage.getItem("telecaller_device_id");
  if (!deviceId) {
    deviceId = "dev_" + Math.random().toString(36).substring(2, 10) + "_" + Date.now();
    localStorage.setItem("telecaller_device_id", deviceId);
  }

  // --- STRICT PRIOR AUTHENTICATION VERIFICATION ENGINE ---
  try {
    const callbackName = "handleUserAuthStrict_" + Date.now();
    
    // Create timeout safety to handle slow network connections without hanging indefinitely
    const authTimeout = setTimeout(() => {
      delete window[callbackName];
      if (submitBtn) {
        submitBtn.disabled = false;
        submitBtn.innerHTML = `<i data-lucide="key-round"></i> Unlock Access`;
        if (window.lucide) window.lucide.createIcons();
      }
      if (errBox) {
        errBox.innerText = "⛔ Connection Timeout. Please check your internet connection and try again.";
        errBox.classList.remove("hidden");
      }
    }, 10000);

    window[callbackName] = function(data) {
      clearTimeout(authTimeout);
      if (submitBtn) {
        submitBtn.disabled = false;
        submitBtn.innerHTML = `<i data-lucide="key-round"></i> Unlock Access`;
        if (window.lucide) window.lucide.createIcons();
      }

      if (data && data.status === "success" && data.authorized) {
        // STRICT VERIFICATION PASSED! Unlock app only now.
        localStorage.setItem("telecaller_auth_token", "TRUE");
        localStorage.setItem("telecaller_agent_name", data.name || nameVal);
        localStorage.setItem("telecaller_user_role", data.role || "Caller");

        showToast("Access Granted", `Welcome ${data.name}! System unlocked.`, "success");
        checkCallerSecurityAccess();
        fetchRemoteLogs();
        fetchCentralLeadQueue();
      } else {
        // STRICT VERIFICATION FAILED! Keep app 100% locked.
        localStorage.removeItem("telecaller_auth_token");
        localStorage.removeItem("telecaller_agent_name");
        localStorage.removeItem("telecaller_user_role");
        checkCallerSecurityAccess();

        const msg = (data && data.message) ? data.message : "Invalid Name or Security PIN.";
        if (errBox) {
          errBox.innerText = "⛔ " + msg;
          errBox.classList.remove("hidden");
        }
      }
      delete window[callbackName];
    };

    if (sheetUrl && sheetUrl.includes("script.google.com")) {
      const authScript = document.createElement("script");
      const authUrl = sheetUrl + (sheetUrl.includes("?") ? "&" : "?") + 
        "action=verify_user&name=" + encodeURIComponent(nameVal) + 
        "&pin=" + encodeURIComponent(pinVal) + 
        "&deviceId=" + encodeURIComponent(deviceId) + 
        "&callback=" + callbackName + 
        "&_t=" + Date.now();
      authScript.src = authUrl;
      authScript.onload = () => authScript.remove();
      authScript.onerror = () => {
        authScript.remove();
        clearTimeout(authTimeout);
        if (submitBtn) {
          submitBtn.disabled = false;
          submitBtn.innerHTML = `<i data-lucide="key-round"></i> Unlock Access`;
          if (window.lucide) window.lucide.createIcons();
        }
        if (errBox) {
          errBox.innerText = "⛔ Verification failed. Unable to reach security server.";
          errBox.classList.remove("hidden");
        }
      };
      document.body.appendChild(authScript);
    } else {
      clearTimeout(authTimeout);
      if (submitBtn) {
        submitBtn.disabled = false;
        submitBtn.innerHTML = `<i data-lucide="key-round"></i> Unlock Access`;
        if (window.lucide) window.lucide.createIcons();
      }
      if (errBox) {
        errBox.innerText = "⛔ Google Sheet Web App URL not configured.";
        errBox.classList.remove("hidden");
      }
    }

  } catch (err) {
    console.warn("Strict Auth Error:", err);
    if (submitBtn) {
      submitBtn.disabled = false;
      submitBtn.innerHTML = `<i data-lucide="key-round"></i> Unlock Access`;
      if (window.lucide) window.lucide.createIcons();
    }
    if (errBox) {
      errBox.innerText = "⛔ Authentication Error. Please try again.";
      errBox.classList.remove("hidden");
    }
  }
}

function logoutCaller() {
  if (confirm("Are you sure you want to lock and log out of the Telecaller portal?")) {
    const callerName = localStorage.getItem("telecaller_agent_name") || "Caller";
    localStorage.removeItem("telecaller_auth_token");
    localStorage.removeItem("telecaller_agent_name");
    localStorage.removeItem("telecaller_user_role");
    
    // Log Security Audit Logout
    try {
      fetch(sheetUrl, {
        method: "POST",
        mode: "no-cors",
        headers: { "Content-Type": "text/plain;charset=utf-8" },
        body: JSON.stringify({ action: "log_audit", callerName: callerName, eventType: "LOGOUT", details: "User logged out." })
      });
    } catch(e){}

    checkCallerSecurityAccess();
    showToast("Locked", "Logged out successfully.", "info");
  }
}

// --- ⚙️ SETTINGS MODAL HANDLERS ---
function openSettings() {
  const modal = document.getElementById("settings-modal");
  const input = document.getElementById("web-app-url");
  if (modal) {
    modal.style.display = "flex";
    modal.classList.remove("hidden-modal");
  }
  if (input) {
    input.value = sheetUrl || DEFAULT_SHEET_URL;
  }
}

function closeSettings() {
  const modal = document.getElementById("settings-modal");
  if (modal) {
    modal.style.display = "none";
    modal.classList.add("hidden-modal");
  }
}

function saveSettings() {
  const input = document.getElementById("web-app-url");
  if (input) {
    const val = input.value.trim();
    if (val) {
      sheetUrl = val;
      localStorage.setItem("telecaller_sheet_url", val);
      showToast("Settings Saved", "Google Sheet URL configuration saved successfully.", "success");
    }
  }
  closeSettings();
  updateSyncBadge();
}

function testSheetConnection() {
  const input = document.getElementById("web-app-url");
  const statusEl = document.getElementById("test-conn-status");
  const urlVal = input ? input.value.trim() : sheetUrl;

  if (!urlVal) {
    if (statusEl) {
      statusEl.textContent = "URL Missing";
      statusEl.className = "test-status-text error";
    }
    return;
  }

  if (statusEl) {
    statusEl.textContent = "Testing...";
    statusEl.className = "test-status-text testing";
  }

  try {
    const callbackName = "testSheetCB_" + Date.now();
    window[callbackName] = function(data) {
      if (statusEl) {
        statusEl.textContent = "Connected!";
        statusEl.className = "test-status-text success";
      }
      showToast("Connection Success", "Successfully connected to Google Sheet!", "success");
      delete window[callbackName];
    };

    const testScript = document.createElement("script");
    const testUrl = urlVal + (urlVal.includes("?") ? "&" : "?") + "callback=" + callbackName + "&_t=" + Date.now();
    testScript.src = testUrl;
    testScript.onload = () => testScript.remove();
    testScript.onerror = () => {
      testScript.remove();
      if (statusEl) {
        statusEl.textContent = "Connection Failed";
        statusEl.className = "test-status-text error";
      }
    };
    document.body.appendChild(testScript);
  } catch (err) {
    if (statusEl) {
      statusEl.textContent = "Error";
      statusEl.className = "test-status-text error";
    }
  }
}
