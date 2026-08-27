/* ==========================================================================
   TELECALL PRO DASHBOARD CORE LOGIC - CRM UPGRADED
   Features: 2-Way Sync Engine, Smart Editing Overwrite, Mobile responsive Tab Layout,
             Expandable Client Calling Cards, Stats Calculations, Local Persistence
   ========================================================================== */

// --- Global Application State ---
let callLogs = [];
let leadQueue = [];
let activeBatchDirectory = "ALL";
let mediaRecorder = null;
let audioChunks = [];
let recordedAudioBase64 = null;
let recordingTimerInterval = null;
let recordingSeconds = 0;

// 💡 UNIVERSAL TEAM CONFIGURATION
// 💡 UNIVERSAL TEAM CONFIGURATION - FIREBASE
const firebaseConfig = {
  apiKey: "AIzaSyClDshgmFBrT4nc-CyyGkPTVHWL2MDnals",
  authDomain: "allied-calling.firebaseapp.com",
  projectId: "allied-calling",
  storageBucket: "allied-calling.firebasestorage.app",
  messagingSenderId: "739358896582",
  appId: "1:739358896582:web:6912d108eb35990a1282c7"
};

// Initialize Firebase
if (typeof firebase !== 'undefined') {
  firebase.initializeApp(firebaseConfig);
}
const db = typeof firebase !== 'undefined' ? firebase.firestore() : null;
let sheetUrl = null; // Removed Google Sheets Url
let editingRecordId = null;

// Gemini key is loaded from localStorage (set once via Settings)

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

  // 8. Always start on Lead Queue tab (default home screen)
  switchMobileTab('queue');

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

    // NOTE: Old one-time flush removed - it was deleting all Firestore leads on new devices

    // sheetUrl is null now (Firebase is used instead of Google Sheets)
  } catch (error) {
    console.error("Error loading local storage data:", error);
    showToast("Error", "Could not load previously saved logs.", "error");
  }
}

// --- IndexedDB fallback for call logs (used when localStorage quota is exceeded) ---
function openLogsDB() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open('callLogsDB', 1);
    request.onupgradeneeded = e => {
      const db = e.target.result;
      if (!db.objectStoreNames.contains('logs')) {
        db.createObjectStore('logs', { keyPath: 'id' });
      }
    };
    request.onsuccess = e => resolve(e.target.result);
    request.onerror = e => reject(e.target.error);
  });
}

async function saveLogsToIndexedDB() {
  try {
    const db = await openLogsDB();
    const tx = db.transaction('logs', 'readwrite');
    const store = tx.objectStore('logs');
    // clear previous entries then bulk add current logs (without audio to keep size low)
    await new Promise(r => store.clear().onsuccess = r);
    const logsWithoutAudio = callLogs.map(r => {
      const { audioRecording, ...rest } = r;
      return rest;
    });
    logsWithoutAudio.forEach(l => store.put(l));
    return new Promise((res, rej) => {
      tx.oncomplete = () => res();
      tx.onerror = e => rej(e.target.error);
    });
  } catch (e) {
    console.error('IndexedDB save failed', e);
    throw e;
  }
}

// Updated saveLogsToLocalStorage with IndexedDB fallback
function saveLogsToLocalStorage() {
  try {
    const logsWithoutAudio = callLogs.map(r => {
      const { audioRecording, ...rest } = r;
      return rest;
    });
    localStorage.setItem('telecaller_logs', JSON.stringify(logsWithoutAudio));
  } catch (error) {
    console.warn('LocalStorage full or unavailable, falling back to IndexedDB', error);
    saveLogsToIndexedDB().catch(e => {
      showToast('Storage Error', 'Unable to persist call logs locally.', 'error');
    });
  }
}

// --- UI Dynamic Form Field Toggles ---
function handleStatusChange() {
  // Appointment/Meeting scheduler is permanently enabled and available for ALL call statuses (Interested, Thinking, Hot List, etc.)
  toggleAppointmentField();
}

function toggleAppointmentField() {
  const appointmentGivenCheckbox = document.getElementById("appointment-given");
  const appointmentDateGroup = document.getElementById("appointment-date-group");
  const appointmentDateInput = document.getElementById("appointment-date");
  if (!appointmentGivenCheckbox || !appointmentDateGroup) return;

  if (appointmentGivenCheckbox.checked) {
    appointmentDateGroup.style.display = "block";
    if (appointmentDateInput) {
      appointmentDateInput.required = true;
      if (!appointmentDateInput.value) {
        // Pre-fill with tomorrow at 10:00 AM by default for easy scheduling
        const tomorrow = new Date();
        tomorrow.setDate(tomorrow.getDate() + 1);
        tomorrow.setHours(10, 0, 0, 0);
        const yyyy = tomorrow.getFullYear();
        const mm = String(tomorrow.getMonth() + 1).padStart(2, '0');
        const dd = String(tomorrow.getDate()).padStart(2, '0');
        const hh = String(tomorrow.getHours()).padStart(2, '0');
        const min = String(tomorrow.getMinutes()).padStart(2, '0');
        appointmentDateInput.value = `${yyyy}-${mm}-${dd}T${hh}:${min}`;
      }
    }
  } else {
    appointmentDateGroup.style.display = "none";
    if (appointmentDateInput) {
      appointmentDateInput.required = false;
      appointmentDateInput.value = "";
    }
  }
}

function toggleBiField() {
  const biRequiredCheckbox = document.getElementById("bi-required");
  const biProductGroup = document.getElementById("bi-product-group");
  const biProductSelect = document.getElementById("bi-product");

  if (biRequiredCheckbox && biRequiredCheckbox.checked) {
    if (biProductGroup) biProductGroup.classList.add("active");
    if (biProductSelect) biProductSelect.required = true;
  } else {
    if (biProductGroup) biProductGroup.classList.remove("active");
    if (biProductSelect) {
      biProductSelect.required = false;
      biProductSelect.value = "";
    }
  }
}

// --- Mobile Tab Switching Logic ---
// switchMobileTab is defined later in the file using the correct panel IDs (tab-queue, tab-form, tab-history)

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
  if (biToggle) biToggle.checked = record.biRequired;
  if (record.biRequired) {
    const biProduct = document.getElementById("bi-product");
    if (biProduct) biProduct.value = record.biProduct || "";
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
  if (!db) return;

  const refreshBtn = document.getElementById("refresh-sync-btn");
  const refreshIcon = document.getElementById("refresh-icon");

  if (refreshIcon) refreshIcon.classList.add("spin-icon");
  if (refreshBtn) refreshBtn.disabled = true;

  try {
    const snapshot = await db.collection('call_logs').orderBy('timestamp', 'desc').limit(200).get();
    const records = [];
    snapshot.forEach(doc => {
      records.push({ id: doc.id, ...doc.data() });
    });

    if (records.length > 0) {
      mergeLogs(records);
      saveLogsToLocalStorage();
      filterCallHistory();
      recalculateAnalytics();
      updateSyncBadge();
      showToast("Sync Successful", `Fetched ${records.length} team logs from Firebase.`, "success");
    }
  } catch (error) {
    console.warn("Could not fetch remote logs from Firebase:", error);
  } finally {
    if (refreshIcon) refreshIcon.classList.remove("spin-icon");
    if (refreshBtn) refreshBtn.disabled = false;
  }
}

window.fetchRemoteLogs = fetchRemoteLogs;

// De-duplicate team records retrieved from Sheet / Firebase
function mergeLogs(remoteRecords) {
  const mergedMap = new Map();

  // 1. Process remote records (normalize fields from Firestore / Sheet)
  remoteRecords.forEach((raw, idx) => {
    if (!raw) return;
    const hasAppt = raw.appointmentGiven === true || 
                     raw.appointmentGiven === "Yes" || 
                     raw.appointmentGiven === "YES" || 
                     (Boolean(raw.appointmentDate) && raw.appointmentDate !== "N/A" && raw.appointmentDate !== "-");

    const cleanRecord = {
      id: raw.id || `rec_${idx}`,
      timestamp: raw.timestamp || raw.callDate || new Date().toISOString(),
      name: raw.name || raw.customerName || raw.doctorName || "N/A",
      mobile: raw.mobile || raw.mobileNumber || "",
      addedBy: raw.addedBy || raw.callerName || raw.telecaller || "N/A",
      status: raw.status || raw.callResult || raw.result || "Thinking",
      age: raw.age || "",
      gender: raw.gender || "",
      comments: raw.comments || raw.remarks || "",
      appointmentGiven: hasAppt,
      appointmentDate: raw.appointmentDate && raw.appointmentDate !== "N/A" ? raw.appointmentDate : "",
      biRequired: raw.biRequired === true || raw.biRequired === "Yes" || raw.biRequired === "YES",
      biProduct: raw.biProduct || "",
      audioRecording: raw.audioBase64 || raw.audioRecording || raw.recordingUrl || raw.audioUrl || "",
      recordingUrl: raw.recordingUrl || raw.audioUrl || "",
      syncStatus: "Synced"
    };
    const key = cleanRecord.id || (cleanRecord.mobile ? `mob_${cleanRecord.mobile}` : `rec_${idx}`);
    mergedMap.set(key, cleanRecord);
  });

  // 2. Add local records that aren't synced or aren't in the remote list yet
  callLogs.forEach((record, idx) => {
    if (!record) return;
    const cleanLocal = {
      ...record,
      name: record.name || record.customerName || "N/A",
      mobile: record.mobile || record.mobileNumber || "",
      addedBy: record.addedBy || record.callerName || "N/A",
      status: record.status || record.callResult || "Thinking"
    };
    const key = cleanLocal.id || (cleanLocal.mobile ? `mob_${cleanLocal.mobile}` : `local_${idx}`);
    if (!mergedMap.has(key)) {
      mergedMap.set(key, cleanLocal);
    } else {
      if (cleanLocal.syncStatus === "Pending") {
        mergedMap.set(key, cleanLocal);
      }
    }
  });

  // 3. Convert back and sort descending by timestamp
  callLogs = Array.from(mergedMap.values()).sort((a, b) => {
    const timeA = a.timestamp ? new Date(a.timestamp).getTime() : 0;
    const timeB = b.timestamp ? new Date(b.timestamp).getTime() : 0;
    return (timeB || 0) - (timeA || 0);
  });
}

// --- Modal Settings Handlers ---
async function openSettings() {
  const modal = document.getElementById("settings-modal");
  const urlInput = document.getElementById("web-app-url");
  const geminiInput = document.getElementById("gemini-api-key-input");
  const geminiStatus = document.getElementById("gemini-key-status");

  urlInput.value = localStorage.getItem("telecaller_sheet_url") || "";

  // Load Gemini key from localStorage only (no Firestore read)
  const savedKey = localStorage.getItem("gemini_api_key") || "";

  if (geminiInput) geminiInput.value = savedKey;
  if (geminiStatus) {
    if (savedKey) {
      const masked = savedKey.slice(0, 6) + '••••••••' + savedKey.slice(-4);
      geminiStatus.innerHTML = `✅ <strong>Key active:</strong> <code style="background:#f0fdf4;padding:2px 6px;border-radius:4px;color:#16a34a;">${masked}</code>`;
    } else {
      geminiStatus.innerHTML = `⚠️ <span style="color:#dc2626;">No key saved yet.</span>`;
    }
  }

  modal.classList.remove("hidden-modal");
  modal.style.display = "flex";

  const testStatus = document.getElementById("test-conn-status");
  testStatus.textContent = urlInput.value ? "Configured (Not Tested)" : "Not Configured";
  testStatus.className = "test-status-text";
}

function closeSettings() {
  document.getElementById("settings-modal").style.display = "none";
}

async function saveSettings() {
  const urlInput = document.getElementById("web-app-url");
  const geminiInput = document.getElementById("gemini-api-key-input");
  const rawUrl = urlInput.value.trim();

  if (rawUrl && !rawUrl.startsWith("https://script.google.com/")) {
    showToast("Invalid URL", "Google Apps Script Web App URLs must start with https://script.google.com", "error");
    return;
  }

  localStorage.setItem("telecaller_sheet_url", rawUrl);
  sheetUrl = rawUrl;

  const geminiKey = geminiInput ? geminiInput.value.trim() : '';
  if (geminiKey) {
    localStorage.setItem("gemini_api_key", geminiKey);
    showToast("✅ Settings Saved", "Gemini AI key saved. Image scanning is now active!", "success");
  } else {
    showToast("Settings Saved", "Settings saved successfully.", "success");
  }

  closeSettings();
  updateSyncBadge();
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
  
  if (db) {
    syncBtn.className = "status-badge state-connected";
    syncText.textContent = "Firebase Connected";
  } else {
    syncBtn.className = "status-badge state-disconnected";
    syncText.textContent = "Database Offline";
  }
}

// --- Form Validation & Submission ---
function handleFormSubmit(event) {
  event.preventDefault();
  try {

  const agentInput = document.getElementById("caller-name");
  const nameInput = document.getElementById("customer-name");
  const mobileInput = document.getElementById("mobile-number");
  const ageInput = document.getElementById("customer-age");
  const genderInput = document.getElementById("customer-gender");
  const statusInput = document.querySelector('input[name="call-status"]:checked');
  const appointmentChecked = document.getElementById("appointment-given") ? document.getElementById("appointment-given").checked : false;
  const appointmentDate = document.getElementById("appointment-date") ? document.getElementById("appointment-date").value : "";
  const appointmentGiven = appointmentChecked || Boolean(appointmentDate && appointmentDate.trim() !== "");
  const biRequired = document.getElementById("bi-required") ? document.getElementById("bi-required").checked : false;
  const biProduct = document.getElementById("bi-product") ? document.getElementById("bi-product").value : "";
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

  // Validate status selected
  if (!status) {
    showToast("Required Field", "Please select a Call Result before saving.", "error");
    return;
  }

  // Helper: match lead by mobile number robustly (strip non-digits)
  function findLeadByMobile(mob) {
    const clean = String(mob).replace(/[^0-9]/g, "").slice(-10);
    return leadQueue.find(l => String(l.mobile).replace(/[^0-9]/g, "").slice(-10) === clean);
  }

  // Helper: mark lead as Called and persist to localStorage + LEADS_CACHE_KEY
  function markLeadCalledLocally(mob) {
    const qItem = findLeadByMobile(mob);
    if (qItem) {
      qItem.status = "Called";
      try {
        const stringified = JSON.stringify(leadQueue);
        localStorage.setItem("telecaller_lead_queue", stringified);
        localStorage.setItem(LEADS_CACHE_KEY, stringified);
      } catch (e) {
        console.warn("Storage quota exceeded while caching leads. Proceeding anyway.", e);
        if (typeof showToast === 'function') {
          showToast("Storage Warning", "Lead cached failed due to storage limits, but log is saved.", "warning");
        }
      }
      renderLeadQueue();
    }
  }

  // 2. Handle Save logic for New vs Updated Record
  if (editingRecordId !== null) {
    // --- EDIT EXISTING CLIENT ---
    const index = callLogs.findIndex(r => r.id === editingRecordId);
    if (index !== -1) {
      const origRecord = callLogs[index];
      
      const updatedRecord = {
        id: origRecord.id,
        timestamp: origRecord.timestamp,
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
        syncStatus: "Pending"
      };

      callLogs[index] = updatedRecord;
      saveLogsToLocalStorage();
      markLeadCalledLocally(mobile);
      renderHistoryTable();
      recalculateAnalytics();
      triggerSheetSync(updatedRecord.id);
      showToast("Record Updated", `Updated details for customer "${name}".`, "success");
      resetForm();
      if (window.innerWidth <= 768) switchMobileTab('history');
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
    markLeadCalledLocally(mobile);
    renderHistoryTable();
    recalculateAnalytics();
    triggerSheetSync(newRecord.id);
    showToast("Record Logged", `Customer "${name}" recorded successfully.`, "success");
    resetForm();
    if (window.innerWidth <= 768) switchMobileTab('history');
  }

  } catch (err) {
    alert('SAVE ERROR: ' + (err.message || err));
    console.error('handleFormSubmit error:', err);
    if (typeof showToast === 'function') {
      showToast('Save Error', err.message || String(err), 'error');
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
  const appointmentDateGroup = document.getElementById("appointment-date-group");
  const appointmentDate = document.getElementById("appointment-date");
  if (appointmentDateGroup) appointmentDateGroup.classList.remove("active");
  if (appointmentDate) {
    appointmentDate.required = false;
    appointmentDate.value = "";
  }

  const biProductGroup = document.getElementById("bi-product-group");
  const biProduct = document.getElementById("bi-product");
  if (biProductGroup) biProductGroup.classList.remove("active");
  if (biProduct) {
    biProduct.required = false;
    biProduct.value = "";
  }
  document.getElementById("customer-gender").value = "";

  handleStatusChange();
}

// --- Google Sheets Sync Engine ---
async function triggerSheetSync(recordId) {
  const index = callLogs.findIndex(r => r.id === recordId);
  if (index === -1) return;

  const record = callLogs[index];
  
  if (!db) {
    console.log(`Firebase not configured. Record ${record.name} kept as Pending Sync.`);
    return;
  }

  updateRecordSyncUiStatus(recordId, "Syncing");

  try {
    const payload = {
      timestamp: record.timestamp || new Date().toISOString(),
      callerName: record.addedBy || "N/A",
      customerName: record.name,
      mobileNumber: record.mobile,
      age: record.age || "N/A",
      gender: record.gender || "",
      city: record.city || "",
      callResult: record.status || "",
      appointmentGiven: record.appointmentGiven ? "Yes" : "No",
      appointmentDate: record.appointmentDate ? formatDateTimeReadable(record.appointmentDate) : "N/A",
      rawAppointmentDate: record.appointmentDate || "",
      biRequired: record.biRequired ? "Yes" : "No",
      biProduct: record.biProduct || "N/A",
      comments: record.comments || "N/A",
      audioBase64: record.audioRecording || ""
    };

    // 1. Upload to Call Logs collection
    await db.collection('call_logs').doc(recordId).set(payload);

    // 2. Update Lead Queue document if mobile matches
    const leadsSnapshot = await db.collection('leads').where('mobile', '==', record.mobile).get();
    if (!leadsSnapshot.empty) {
      const batch = db.batch();
      leadsSnapshot.forEach(doc => {
        batch.update(doc.ref, { status: "Called" });
      });
      await batch.commit();
    }

    callLogs[index].syncStatus = "Synced";
    saveLogsToLocalStorage();
    updateRecordSyncUiStatus(recordId, "Synced");
    showToast("Synced to Firebase", `"${record.name}" logged successfully.`, "success");

  } catch (error) {
    console.error("Firebase Sync Error:", error);
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

  const apptsCount = callLogs.filter(r => r.appointmentGiven === true || (Boolean(r.appointmentDate) && r.appointmentDate !== "N/A" && r.appointmentDate !== "-")).length;
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
    const totalCount = callLogs.length;
    const emptyStateHtml = `
      <div class="empty-state" style="padding: 2.5rem 1rem; text-align: center;">
        <i data-lucide="clipboard-list" class="empty-icon"></i>
        <h3>No call logs matching selected date/filter</h3>
        <p style="margin-top:0.25rem; color:#64748b;">No records found for the current search/date. Clear the filter to view all historical logs.</p>
        <button type="button" class="btn-primary" onclick="clearDateFilter(); document.getElementById('search-input').value=''; filterCallHistory();" style="margin-top:0.85rem; padding:0.45rem 1rem; font-weight:600;">Show All ${totalCount} Historical Logs</button>
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

  const visibleLogs = activeLogs.slice(0, 100);

  visibleLogs.forEach(record => {
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
      } else if (record.status === "Not Answered") {
        statusClass = "tbl-badge-not-answered";
        statusIcon = "phone-missed";
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
        const downloadName = `Call_${(record.name || 'Lead').replace(/[^a-zA-Z0-9]/g, '_')}_${record.mobile || ''}.webm`;
        audioCell = `
          <td>
            <div style="display:flex; align-items:center; gap:6px;">
              <audio controls style="height:28px; width:130px;" src="${record.audioRecording}"></audio>
              <a href="${record.audioRecording}" download="${downloadName}" class="icon-btn-sm" title="Download Audio" style="display:inline-flex; align-items:center; justify-content:center; padding:4px; border-radius:6px; background:#e0e7ff; color:#4338ca; text-decoration:none;">
                <i data-lucide="download" style="width:14px; height:14px;"></i>
              </a>
            </div>
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
      } else if (record.status === "Hot List") {
        statusClass = "tbl-badge-hot-list";
        statusIcon = "flame";
      } else if (record.status === "Not Interested") {
        statusClass = "tbl-badge-refused";
        statusIcon = "thumbs-down";
      } else if (record.status === "Lead") {
        statusClass = "tbl-badge-lead";
        statusIcon = "sparkles";
      } else if (record.status === "Not Answered") {
        statusClass = "tbl-badge-not-answered";
        statusIcon = "phone-missed";
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
        const downloadName = `Call_${(record.name || 'Lead').replace(/[^a-zA-Z0-9]/g, '_')}_${record.mobile || ''}.webm`;
        audioPlayerHtml = `
          <div class="m-card-detail-item" style="flex-direction:column; align-items:flex-start; margin-top:0.4rem;">
            <div style="display:flex; justify-content:space-between; align-items:center; width:100%;">
              <span class="m-card-detail-label">🎙️ Call Audio Recording:</span>
              <a href="${record.audioRecording}" download="${downloadName}" style="font-size:0.75rem; font-weight:600; color:#4f46e5; text-decoration:none; display:flex; align-items:center; gap:3px;">
                <i data-lucide="download" style="width:12px; height:12px;"></i> Download Audio
              </a>
            </div>
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
                          (searchInput.replace(/[^0-9]/g, "").length >= 4 && recMobile.replace(/[^0-9]/g, "").slice(-10).includes(searchInput.replace(/[^0-9]/g, "").slice(-10))) ||
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
  if (typeof dateInput === 'object' && dateInput.toDate) {
    dateInput = dateInput.toDate();
  } else if (typeof dateInput === 'object' && dateInput.seconds) {
    dateInput = new Date(dateInput.seconds * 1000);
  }
  
  if (typeof dateInput === 'string') {
    const trimmed = dateInput.trim();
    // DD/MM/YYYY or DD-MM-YYYY
    const ddmmyyyy = trimmed.match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{4})/);
    if (ddmmyyyy) {
      const day = ddmmyyyy[1].padStart(2, '0');
      const month = ddmmyyyy[2].padStart(2, '0');
      const year = ddmmyyyy[3];
      return `${year}-${month}-${day}`;
    }
    // YYYY-MM-DD
    const yyyymmdd = trimmed.match(/^(\d{4})[\/\-](\d{1,2})[\/\-](\d{1,2})/);
    if (yyyymmdd) {
      const year = yyyymmdd[1];
      const month = yyyymmdd[2].padStart(2, '0');
      const day = yyyymmdd[3].padStart(2, '0');
      return `${year}-${month}-${day}`;
    }
  }

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

// --- 🎙️ Microphone Recording Gate (Native Browser Permission) ---
// No custom modal. Browser handles its own permission UI natively.
// On first use, Chrome shows its own "Allow microphone?" popup automatically.
// After that, permission is remembered forever - no more prompts.

async function acquireMicrophoneAndRecord() {
  try {
    // This triggers Chrome's native permission popup if not yet granted.
    // If already granted, it silently proceeds.
    await startAutoCallRecording();
    return true;
  } catch (err) {
    console.warn("Microphone not available:", err);
    return false;
  }
}

// --- 📞 Click-to-Call & 💬 WhatsApp Direct Launcher ---
async function triggerClickToCall(targetMobile = null) {
  const mob = targetMobile || document.getElementById("mobile-number").value.trim();
  const cleanMobile = mob.replace(/[^0-9]/g, "");
  if (!cleanMobile || cleanMobile.length < 10) {
    showToast("Invalid Mobile", "Please enter or select a valid 10-digit mobile number to call.", "error");
    return;
  }

  // Start mic recording in background (browser will ask for permission if needed)
  acquireMicrophoneAndRecord();

  // Immediately launch phone dialer - no blocking gate
  window.location.href = `tel:${cleanMobile}`;
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
  const defaultMsg = encodeURIComponent(`${greeting}thanks for giving us time. Please save this number for further communication regarding your investment plan.`);
  
  const waUrl = `https://wa.me/${cleanMobile}?text=${defaultMsg}`;
  window.open(waUrl, '_blank');
  showToast("WhatsApp Direct", `Opening WhatsApp chat with +${cleanMobile}.`, "success");
}

// Helper to strip non-printable/corrupted symbols
function sanitizeText(str) {
  if (!str) return "";
  let clean = String(str).replace(/[^\x20-\x7E\t\r\n]/g, " ").trim();
  clean = clean.replace(/\s+/g, " ");
  if (clean.length > 60) clean = clean.substring(0, 60);
  return clean;
}

function switchLeadDirectory(dirName) {
  activeBatchDirectory = dirName || "ALL";
  renderLeadQueue();
}

// --- 📊 Excel/CSV/Image Lead Upload & Directory Engine ---
async function handleExcelUpload(event) {
  const file = event.target.files[0];
  if (!file) return;

  const validExtensions = ['.xlsx', '.xls', '.csv', '.png', '.jpg', '.jpeg'];
  const fileName = file.name.toLowerCase();
  const isValid = validExtensions.some(ext => fileName.endsWith(ext));
  
  if (!isValid) {
    showToast("Invalid File", "Please upload an Excel (.xlsx, .csv) or Image (.png, .jpg) file.", "error");
    event.target.value = "";
    return;
  }

  // 1. Prompt Admin for Custom Directory / Campaign Name
  const defaultDirName = file.name.replace(/\.[^/.]+$/, "").replace(/[^a-zA-Z0-9\s_-]/g, " ").trim();
  const promptVal = prompt("🏷️ Enter Lead Directory / Campaign Name:\n(This will group your leads into a dedicated directory)", defaultDirName);
  
  if (promptVal === null) {
    event.target.value = "";
    return; // Cancelled
  }

  const directoryName = sanitizeText(promptVal).trim() || defaultDirName || "General Batch";
  const isImage = ['.png', '.jpg', '.jpeg'].some(ext => fileName.endsWith(ext));

  // --- ENTERPRISE AI IMAGE SCANNING (Gemini Vision) ---
  if (isImage) {
    const geminiKey = localStorage.getItem('gemini_api_key') || '';

    if (!geminiKey) {
      showToast(
        '🔑 Gemini API Key Required',
        'Go to Settings → paste your free Gemini API key to enable AI image scanning.',
        'error'
      );
      event.target.value = '';
      return;
    }

    showToast('🤖 AI Scanning...', 'Gemini Vision is reading your image...', 'info');

    try {
      // Convert image file to base64
      const base64 = await new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = e => resolve(e.target.result.split(',')[1]);
        reader.onerror = reject;
        reader.readAsDataURL(file);
      });

      const mimeType = file.type || 'image/jpeg';

      // Call Gemini Vision API — tries multiple models with retry on overload
      const MODELS = [
        { ver: 'v1', name: 'gemini-2.0-flash' },
        { ver: 'v1', name: 'gemini-1.5-flash' },
        { ver: 'v1beta', name: 'gemini-2.0-flash' },
        { ver: 'v1beta', name: 'gemini-pro-vision' },
      ];
      let response = null;
      let lastError = '';

      for (const { ver, name } of MODELS) {
        for (let attempt = 1; attempt <= 2; attempt++) {
          try {
            response = await fetch(
              `https://generativelanguage.googleapis.com/${ver}/models/${name}:generateContent?key=${geminiKey}`,
              {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                  contents: [{ parts: [
                    { text: 'Extract ALL 10-digit mobile phone numbers from this image. Return ONLY the numbers, one per line, nothing else.' },
                    { inline_data: { mime_type: mimeType, data: base64 } }
                  ]}],
                  generationConfig: { temperature: 0, maxOutputTokens: 2048 }
                })
              }
            );
            if (response.ok) break;
            const errBody = await response.json();
            lastError = errBody.error?.message || 'API error';
            if (lastError.includes('overloaded') && attempt < 2) {
              await new Promise(r => setTimeout(r, 2000));
            }
          } catch(e) { lastError = e.message; }
        }
        if (response && response.ok) break;
      }

      if (!response || !response.ok) {
        throw new Error(lastError || 'All Gemini models failed. Please try again in a moment.');
      }

      const result = await response.json();
      const aiText = result.candidates?.[0]?.content?.parts?.[0]?.text || '';

      // Extract all valid numbers from AI response
      const seen = new Set();
      const newQueue = [];
      let parsedCount = 0;

      const allDigits = aiText.match(/\d{10,12}/g) || [];
      allDigits.forEach((raw, index) => {
        let d = raw;
        if (d.length === 12 && d.startsWith('91')) d = d.slice(2);
        if (d.length === 11 && d.startsWith('0'))  d = d.slice(1);
        if (d.length === 10 && !seen.has(d)) {
          seen.add(d);
          newQueue.push({
            id: `lead_ai_${Date.now()}_${index}`,
            name: `${directoryName} Lead ${parsedCount + 1}`,
            mobile: d,
            category: 'Image Scan',
            sourceFile: directoryName,
            status: 'Pending'
          });
          parsedCount++;
        }
      });

      if (parsedCount === 0) {
        showToast('No Numbers Found', 'AI could not detect any 10-digit numbers in this image. Ensure image is clear.', 'error');
        event.target.value = '';
        return;
      }

      const existingMobiles = new Set(leadQueue.map(l => String(l.mobile)));
      const dedupedNew = newQueue.filter(l => !existingMobiles.has(String(l.mobile)));
      const dupes = parsedCount - dedupedNew.length;

      leadQueue = [...dedupedNew, ...leadQueue];
      activeBatchDirectory = 'ALL';
      saveLeadQueueToLocalStorage();
      renderLeadQueue();
      syncCentralLeadQueue(dedupedNew, false);

      showToast(
        '✅ AI Scan Complete',
        `${dedupedNew.length} leads added from image"${directoryName}"${dupes > 0 ? `. ${dupes} duplicates skipped.` : ''}`,
        'success'
      );

    } catch (aiErr) {
      console.error('Gemini Vision Error:', aiErr);
      showToast('AI Scan Failed', `Error: ${aiErr.message}. Check your API key in Settings.`, 'error');
    } finally {
      event.target.value = '';
    }
    return;
  }

  // --- EXCEL / CSV PARSER ---
  showToast("Uploading...", "Reading spreadsheet file, please wait...", "info");
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
        let category = "";

        const nameAliases = ["customer name", "name", "client name", "full name", "client", "customer", "lead name", "lead", "doctor name", "doctor", "name of doctor", "party name", "party", "company name", "company", "firm name", "firm", "contact person", "contact name", "dealer name", "dealer", "agency name", "agency", "owner name", "owner", "business name", "business", "shop name", "shop", "store name", "name of client", "name of customer", "title"];
        const phoneAliases = ["owner mobile number", "owner mobile", "mobile number", "mobile", "phone number", "phone", "contact number", "contact", "cell", "telephone", "mobile no", "phone no", "mobile_no", "mob", "whatsapp", "whatsapp number"];
        const ignorePhoneHeaders = ["registration", "reg", "chassis", "engine", "policy", "amount", "price", "capacity", "capa", "seat", "pin", "pincode", "zip", "serial", "sl", "id", "model"];
        const stateCityNames = ["west bengal", "maharashtra", "delhi", "gujarat", "karnataka", "tamil nadu", "bihar", "kolkata", "mumbai", "india", "state"];

        // 1. Smart Name & Meta Extraction
        for (let k of rowKeys) {
          const cleanK = k.toLowerCase().trim();
          const val = sanitizeText(row[k]);
          if (!val) continue;

          if (nameAliases.some(alias => cleanK === alias || cleanK.includes(alias))) {
            if (!name) name = val;
          } else if (["age", "customer age"].includes(cleanK)) {
            if (!age) age = val;
          } else if (["gender", "sex"].includes(cleanK)) {
            if (!gender) gender = val;
          } else if (["city", "location", "area", "state"].includes(cleanK)) {
            if (!city) city = val;
          } else if (["category", "speciality", "specialization", "specialty", "type", "doctor type", "doc type", "segment"].includes(cleanK)) {
            if (!category) category = val;
          }
        }

        // 2. Strict Indian Mobile Extractor (Ignores Registration / Serial / Chassis Numbers)
        let mobile = "";
        
        // Step 2A: Check explicit phone header columns first
        for (let k of rowKeys) {
          const cleanK = k.toLowerCase().trim();
          if (ignorePhoneHeaders.some(ig => cleanK.includes(ig))) continue;

          if (phoneAliases.some(alias => cleanK === alias || cleanK.includes(alias))) {
            const valStr = String(row[k] || "").trim().replace(/[^0-9]/g, "");
            let cleaned = valStr;
            if (cleaned.length === 12 && cleaned.startsWith("91")) cleaned = cleaned.slice(2);
            if (cleaned.length > 10) cleaned = cleaned.slice(-10);
            if (cleaned.length === 10 && /^[6-9]/.test(cleaned)) {
              mobile = cleaned;
              break;
            }
          }
        }

        // Step 2B: Fallback scan across non-ignored columns for valid 10-digit number starting 6-9
        if (!mobile) {
          for (let k of rowKeys) {
            const cleanK = k.toLowerCase().trim();
            if (ignorePhoneHeaders.some(ig => cleanK.includes(ig))) continue;

            const valStr = String(row[k] || "").trim().replace(/[^0-9]/g, "");
            let cleaned = valStr;
            if (cleaned.length === 12 && cleaned.startsWith("91")) cleaned = cleaned.slice(2);
            if (cleaned.length > 10) cleaned = cleaned.slice(-10);
            if (cleaned.length === 10 && /^[6-9]/.test(cleaned)) {
              mobile = cleaned;
              break;
            }
          }
        }

        // 3. Fallback for Name: pick first text cell that is NOT a mobile number and NOT a state name
        if (!name) {
          for (let k of rowKeys) {
            const valStr = sanitizeText(row[k]);
            const lowerVal = valStr.toLowerCase();
            const isStateName = stateCityNames.some(s => lowerVal.includes(s));
            if (valStr && valStr !== mobile && isNaN(valStr) && valStr.length > 1 && !isStateName) {
              name = valStr;
              break;
            }
          }
        }

        if (mobile.length === 10) {
          newQueue.push({
            id: `lead_${Date.now()}_${index}`,
            name: sanitizeText(name) || `Lead ${parsedCount + 1}`,
            mobile: mobile,
            age: sanitizeText(age),
            gender: sanitizeText(gender),
            city: sanitizeText(city),
            category: sanitizeText(category),
            sourceFile: directoryName,
            status: "Pending"
          });
          parsedCount++;
        }
      });

      if (parsedCount === 0) {
        showToast("No Valid Numbers", "Could not find valid 10-digit mobile numbers in the file.", "error");
        return;
      }

      const existingMobiles = new Set(leadQueue.map(l => String(l.mobile)));
      const dedupedNew = newQueue.filter(l => !existingMobiles.has(String(l.mobile)));
      const skipped = parsedCount - dedupedNew.length;

      leadQueue = [...dedupedNew, ...leadQueue];
      activeBatchDirectory = "ALL"; // show ALL directories so old data stays visible
      saveLeadQueueToLocalStorage();
      renderLeadQueue();

      syncCentralLeadQueue(dedupedNew, false);

      const msg = skipped > 0
        ? `${dedupedNew.length} new leads added to directory "${directoryName}". ${skipped} duplicates skipped.`
        : `${dedupedNew.length} leads added to directory "${directoryName}"!`;
      showToast("✅ Directory Created", msg, "success");

    } catch (err) {
      console.error("Excel parse error:", err);
      showToast("Import Failed", "Failed to parse Excel file. Please upload a valid file.", "error");
    } finally {
      event.target.value = "";
    }
  };

  reader.readAsArrayBuffer(file);
}

async function syncCentralLeadQueue(newLeads, replace = false) {
  if (!db) return;
  if (!replace && (!newLeads || newLeads.length === 0)) return;
  
  try {
    const leadsRef = db.collection('leads');
    
    if (replace) {
      // Clear old leads first (max 500 per batch, so we fetch and delete)
      const snapshot = await leadsRef.get();
      if (!snapshot.empty) {
        const batch = db.batch();
        snapshot.docs.forEach(doc => {
          batch.delete(doc.ref);
        });
        await batch.commit();
      }
    }

    if (newLeads && newLeads.length > 0) {
      // Add new leads in batches of 400
      let batch = db.batch();
      let count = 0;

      for (const lead of newLeads) {
        const docRef = leadsRef.doc(lead.id || `lead_${Date.now()}_${Math.random().toString(36).substr(2,9)}`);
        batch.set(docRef, lead);
        count++;

        if (count === 400) {
          await batch.commit();
          batch = db.batch();
          count = 0;
        }
      }
      if (count > 0) {
        await batch.commit();
      }
    }
    
    console.log(`Lead queue synced to Firebase: ${newLeads ? newLeads.length : 0} leads (replace=${replace}).`);
  } catch (err) {
    console.warn("Could not sync central lead queue:", err);
  }
}

let unsubscribeLeads = null;
const LEADS_CACHE_KEY   = 'allied_leads_cache';
const LEADS_CACHE_TS    = 'allied_leads_cache_ts';
const CACHE_TTL_MS      = 30 * 60 * 1000; // 30 minutes — ensures Called status syncs across callers

async function fetchCentralLeadQueue(forceSync = false) {
  if (!db) return;

  // Step 1: Load from localStorage INSTANTLY (zero Firestore reads)
  const cached = localStorage.getItem(LEADS_CACHE_KEY);
  const cachedTs = parseInt(localStorage.getItem(LEADS_CACHE_TS) || '0', 10);
  const cacheAge = Date.now() - cachedTs;
  const cacheValid = cached && cacheAge < CACHE_TTL_MS;

  if (cached && leadQueue.length === 0) {
    try {
      const parsed = JSON.parse(cached);
      if (Array.isArray(parsed) && parsed.length > 0) {
        leadQueue = parsed;
        renderLeadQueue();
        if (!forceSync && cacheValid) {
          // Cache is fresh — no Firestore read needed at all
          return;
        }
      }
    } catch(e) {}
  }

  // Step 2: Only hit Firestore if cache is stale OR force sync requested
  if (!forceSync && cacheValid && leadQueue.length > 0) return;

  try {
    showToast('🔄 Syncing leads...', 'Fetching latest leads from server...', 'info');
    const snapshot = await db.collection('leads').get();
    const remoteQueue = [];
    snapshot.forEach(doc => remoteQueue.push({ id: doc.id, ...doc.data() }));

    mergeLeadQueue(remoteQueue);

    // Save fresh data + timestamp to localStorage cache
    try {
      localStorage.setItem(LEADS_CACHE_KEY, JSON.stringify(leadQueue));
      localStorage.setItem(LEADS_CACHE_TS, String(Date.now()));
    } catch(e) {
      console.warn('Quota exceeded when caching leads from Firestore', e);
    }
    saveLeadQueueToLocalStorage();
    renderLeadQueue();

    if (remoteQueue.length > 0) {
      showToast('✅ Leads Ready', `${leadQueue.length} leads loaded!`, 'success');
    }
  } catch (err) {
    console.warn('Could not fetch remote lead queue:', err);
    showToast('⚠️ Offline Mode', 'Using cached leads. Sync when connection is restored.', 'info');
  }
}

function mergeLeadQueue(remoteQueue) {
  if (!remoteQueue || !Array.isArray(remoteQueue) || remoteQueue.length === 0) return;
  const map = new Map();

  // Remote (Firestore) is always the source of truth for status
  // This ensures Jayeeta sees "Called" when Moupriya has logged a call
  remoteQueue.forEach((item, idx) => {
    if (item) {
      const mob = item.mobile ? String(item.mobile).replace(/[^0-9]/g, "") : "";
      const key = mob || item.id || `lead_key_${idx}`;
      const cleanItem = {
        id: item.id || `lead_remote_${idx}_${Date.now()}`,
        name: sanitizeText(item.name) || `Lead ${idx + 1}`,
        mobile: mob || "N/A",
        age: sanitizeText(item.age),
        gender: sanitizeText(item.gender),
        city: sanitizeText(item.city),
        category: sanitizeText(item.category),
        sourceFile: sanitizeText(item.sourceFile) || "General Batch",
        // Remote status wins — if Moupriya marked "Called" in Firestore, Jayeeta sees "Called"
        status: item.status || "Pending"
      };
      map.set(key, cleanItem);
    }
  });

  leadQueue = Array.from(map.values());
}

function saveLeadQueueToLocalStorage() {
  try {
    localStorage.setItem("telecaller_lead_queue", JSON.stringify(leadQueue));
  } catch(e) {
    console.warn("Could not save lead queue to localStorage due to quota.", e);
  }
}

// ============================================================
// PASTE & IMPORT - Permanent reliable lead import from any text
// ============================================================
function openPasteModal() {
  const modal = document.getElementById('paste-modal');
  if (modal) {
    modal.style.display = 'flex';
    document.getElementById('paste-numbers-input').value = '';
    document.getElementById('paste-directory-name').value = '';
    document.getElementById('paste-preview').textContent = '';
    setTimeout(() => document.getElementById('paste-directory-name').focus(), 100);
  }
}

function closePasteModal() {
  const modal = document.getElementById('paste-modal');
  if (modal) modal.style.display = 'none';
}

// Live preview: count numbers as user types
document.addEventListener('DOMContentLoaded', () => {
  const ta = document.getElementById('paste-numbers-input');
  if (ta) {
    ta.addEventListener('input', () => {
      const nums = extractNumbersFromText(ta.value);
      const prev = document.getElementById('paste-preview');
      if (prev) {
        prev.textContent = nums.length > 0
          ? `✅ ${nums.length} valid mobile number${nums.length > 1 ? 's' : ''} detected`
          : 'No valid 10-digit numbers found yet...';
        prev.style.color = nums.length > 0 ? '#16a34a' : '#94a3b8';
      }
    });
  }
});

// Core extractor: finds ALL valid 10-digit Indian mobile numbers from any text
function extractNumbersFromText(text) {
  const found = [];
  const seen = new Set();

  // Step 1: match 10-digit blocks (handles spaces, dashes, dots between digits)
  const raw = text.match(/[6-9][\d\s\.\-]{8,14}\d/g) || [];
  raw.forEach(r => {
    const digits = r.replace(/\D/g, '');
    let d = digits;
    if (d.length === 12 && d.startsWith('91')) d = d.slice(2);
    if (d.length === 11 && d.startsWith('0'))  d = d.slice(1);
    if (d.length === 10 && !seen.has(d)) { seen.add(d); found.push(d); }
  });

  // Step 2: plain 10-digit fallback for tightly packed numbers
  const plain = text.match(/\d{10,12}/g) || [];
  plain.forEach(r => {
    let d = r;
    if (d.length === 12 && d.startsWith('91')) d = d.slice(2);
    if (d.length === 11 && d.startsWith('0'))  d = d.slice(1);
    if (d.length === 10 && /^[6-9]/.test(d) && !seen.has(d)) {
      seen.add(d); found.push(d);
    }
  });

  return found;
}

async function importPastedNumbers() {
  const text = (document.getElementById('paste-numbers-input').value || '').trim();
  const rawDir = (document.getElementById('paste-directory-name').value || '').trim();
  const directoryName = rawDir || 'Pasted Leads';

  if (!text) {
    showToast('Empty', 'Please paste some numbers first.', 'error');
    return;
  }

  const numbers = extractNumbersFromText(text);
  if (numbers.length === 0) {
    showToast('No Numbers Found', 'Could not find any valid 10-digit mobile numbers in the pasted text.', 'error');
    return;
  }

  closePasteModal();
  showToast('Importing...', `Found ${numbers.length} numbers. Adding to lead queue...`, 'info');

  // Deduplicate against existing queue
  const existingMobiles = new Set(leadQueue.map(l => String(l.mobile)));
  const newLeads = [];

  numbers.forEach((mob, i) => {
    if (existingMobiles.has(mob)) return; // skip duplicate

    // Try to find a name near the number in the original text
    const pos = text.indexOf(mob);
    const surrounding = text.substring(Math.max(0, pos - 50), pos + mob.length + 30);
    let name = surrounding.replace(mob, '').replace(/[^a-zA-Z\s]/g, ' ').trim().replace(/\s+/g, ' ');
    if (!name || name.length < 2) name = `${directoryName} Lead ${i + 1}`;

    newLeads.push({
      id: `lead_paste_${Date.now()}_${i}`,
      name: name,
      mobile: mob,
      category: 'Pasted',
      sourceFile: directoryName,
      status: 'Pending'
    });
  });

  if (newLeads.length === 0) {
    showToast('All Duplicates', 'All numbers already exist in your lead queue.', 'info');
    return;
  }

  // Add to local queue
  leadQueue = [...newLeads, ...leadQueue];
  activeBatchDirectory = 'ALL';
  saveLeadQueueToLocalStorage();
  renderLeadQueue();

  // Sync to Firebase
  syncCentralLeadQueue(newLeads, false);

  const skipped = numbers.length - newLeads.length;
  showToast('✅ Leads Imported!',
    `Added ${newLeads.length} leads to "${directoryName}"${skipped > 0 ? `. ${skipped} duplicates skipped.` : ''}`,
    'success');
}

function clearLeadQueue() {
  if (confirm("Are you sure you want to clear all imported leads from the queue?")) {
    leadQueue = [];
    activeBatchDirectory = "ALL";
    saveLeadQueueToLocalStorage();
    renderLeadQueue();
    syncCentralLeadQueue([], true);
    showToast("Queue Cleared", "All leads cleared from queue and Google Sheets.", "info");
  }
}

function renderLeadQueue(leadsToShow) {
  const container = document.getElementById('lead-queue-container');
  const badge = document.getElementById('queue-badge-count');
  const dirSelect = document.getElementById('batch-directory-select');
  if (!container) return;

  // 1. Populate Lead Directory Selector Dropdown
  if (dirSelect) {
    const dirCounts = {};
    leadQueue.forEach(l => {
      const src = l.sourceFile || "General Batch";
      dirCounts[src] = (dirCounts[src] || 0) + 1;
    });

    const previousSelection = dirSelect.value || activeBatchDirectory;
    dirSelect.innerHTML = `<option value="ALL">📂 All Lead Directories (${leadQueue.length} total)</option>`;
    
    Object.keys(dirCounts).sort().forEach(dirName => {
      const opt = document.createElement('option');
      opt.value = dirName;
      opt.textContent = `📂 ${dirName} (${dirCounts[dirName]} leads)`;
      dirSelect.appendChild(opt);
    });

    if (Object.keys(dirCounts).includes(previousSelection) || previousSelection === "ALL") {
      dirSelect.value = previousSelection;
    } else {
      dirSelect.value = "ALL";
    }
    activeBatchDirectory = dirSelect.value;
  }

  // 2. Filter list by Directory & Search Query
  let displayList = leadsToShow !== undefined ? leadsToShow : leadQueue;
  if (activeBatchDirectory && activeBatchDirectory !== "ALL") {
    displayList = displayList.filter(l => (l.sourceFile || "General Batch") === activeBatchDirectory);
  }

  if (badge) {
    const pendingCount = displayList.filter(l => l.status === 'Pending').length;
    badge.textContent = `${pendingCount} / ${displayList.length} Pending`;
  }

  if (displayList.length === 0) {
    container.innerHTML = `
      <div class="empty-state">
        <i data-lucide="users" style="width:40px;height:40px;color:#94a3b8;"></i>
        <p>${leadQueue.length === 0 ? 'Tap <strong>Sync</strong> below or upload a file to load your Lead Directory' : 'No leads found in this directory'}</p>
      </div>
    `;
    if (window.lucide) window.lucide.createIcons();
    return;
  }

  // Limit to 100 visible cards for fast performance
  const visibleLeads = displayList.slice(0, 100);
  container.innerHTML = '';

  visibleLeads.forEach(lead => {
    const isCalled = lead.status === 'Called';
    const isHot = lead.status === 'Hot List';
    const card = document.createElement('div');
    card.className = 'lead-card' + (isCalled ? ' called-card' : '');
    card.setAttribute('data-queue-id', lead.id);

    const statusText = isCalled ? 'Called ✓' : (isHot ? '🔥 Hot List' : 'Pending');
    const statusClass = isCalled ? 'badge-called' : (isHot ? 'badge-hot' : 'badge-pending');

    // Build meta tags: mobile + category + city + directory badge
    let metaTags = `<span class="lead-tag">📞 ${escapeHtml(String(lead.mobile))}</span>`;
    if (lead.category) metaTags += `<span class="lead-tag category-tag">🏷 ${escapeHtml(lead.category)}</span>`;
    if (lead.city) metaTags += `<span class="lead-tag">📍 ${escapeHtml(lead.city)}</span>`;
    if (lead.sourceFile) metaTags += `<span class="card-dir-badge">📂 ${escapeHtml(lead.sourceFile)}</span>`;

    card.innerHTML = `
      <div class="lead-card-top">
        <div>
          <div class="lead-name">${escapeHtml(lead.name)}</div>
          <div class="lead-meta">${metaTags}</div>
        </div>
        <span class="lead-status-badge ${statusClass}">${statusText}</span>
      </div>
      <div class="lead-card-actions">
        <button type="button" class="btn-call-big" onclick="triggerClickToCall('${lead.mobile}'); markLeadStatus('${lead.id}', 'Called');">
          <i data-lucide="phone-call"></i> Call
        </button>
        <button type="button" class="btn-wa" onclick="triggerWhatsAppChat('${lead.mobile}', '${escapeHtml(lead.name).replace(/'/g, "'")}')" title="WhatsApp">💬</button>
        <button type="button" class="btn-log" onclick="loadLeadToForm('${lead.id}')" title="Log Call">
          <i data-lucide="edit-3"></i> Log
        </button>
      </div>
    `;
    container.appendChild(card);
  });

  if (window.lucide) window.lucide.createIcons();
}

// Search / filter the lead queue
function filterLeadQueue(query) {
  const q = (query || '').toLowerCase().trim();
  const qCleanMobile = q.replace(/[^0-9]/g, "").slice(-10);

  if (!q) {
    renderLeadQueue();
    return;
  }
  const filtered = leadQueue.filter(l => {
    const name = (l.name || '').toLowerCase();
    const mobile = String(l.mobile || '').toLowerCase();
    const cleanMobile = mobile.replace(/[^0-9]/g, "").slice(-10);
    const category = (l.category || '').toLowerCase();
    const city = (l.city || '').toLowerCase();
    
    return name.includes(q) || 
           mobile.includes(q) || 
           (qCleanMobile.length >= 4 && cleanMobile.includes(qCleanMobile)) || 
           category.includes(q) || 
           city.includes(q);
  });
  renderLeadQueue(filtered);
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
    // Also update the leads cache so other callers see it on next sync
    try {
      localStorage.setItem(LEADS_CACHE_KEY, JSON.stringify(leadQueue));
    } catch(e) {
      console.warn("Quota exceeded caching lead status", e);
    }
    renderLeadQueue();
    // Write to Firestore so Jayeeta / other callers get updated status immediately
    if (db) {
      db.collection('leads').doc(leadId).update({ status: newStatus }).catch(() => {
        // If doc doesn't exist by ID, try finding by mobile number
        const lead = leadQueue[index];
        if (lead && lead.mobile) {
          db.collection('leads').where('mobile', '==', String(lead.mobile)).get().then(snap => {
            if (!snap.empty) {
              const batch = db.batch();
              snap.forEach(doc => batch.update(doc.ref, { status: newStatus }));
              batch.commit();
            }
          });
        }
      });
    }
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
  const modal = document.getElementById('calls-audit-modal');
  const bodyEl = document.getElementById('calls-audit-modal-body');
  const titleEl = document.getElementById('calls-audit-modal-title');

  if (!modal || !bodyEl) return;

  // Base list of valid call records
  let filteredList = callLogs.filter(r => r.mobile && r.mobile.toString().replace(/[^0-9]/g, '').length >= 10);
  let categoryTitle = 'Daily Outbound Calls Audit';

  if (filterCategory === 'hotlist') {
    filteredList = filteredList.filter(r => r.status === 'Hot List');
    categoryTitle = '🔥 Hot List Prospects';
  } else if (filterCategory === 'appointments') {
    filteredList = filteredList.filter(r => r.appointmentGiven === true);
    categoryTitle = '📅 Appointments Secured';
  } else if (filterCategory === 'bi') {
    filteredList = filteredList.filter(r => r.biRequired === true);
    categoryTitle = '📄 BI Requests';
  } else if (filterCategory === 'interested') {
    filteredList = filteredList.filter(r => r.status === 'Interested');
    categoryTitle = '👍 Interested Leads';
  }

  if (titleEl) titleEl.textContent = `${categoryTitle} (${filteredList.length})`;

  if (filteredList.length === 0) {
    bodyEl.innerHTML = `<div class="empty-state" style="padding:2rem;"><p>No records in this category yet.</p></div>`;
  } else {
    bodyEl.innerHTML = filteredList.map(r => {
      const cleanMob = r.mobile.toString().replace(/[^0-9]/g, '');
      const timeStr = r.timestamp ? formatDateTimeReadable(r.timestamp) : '—';
      let extra = '';
      if (r.appointmentGiven) extra += `<br><span style="color:#059669;font-size:0.72rem;">📅 ${formatDateTimeReadable(r.appointmentDate)}</span>`;
      if (r.biRequired) extra += `<br><span style="color:#4338ca;font-size:0.72rem;">📄 BI: ${escapeHtml(r.biProduct || 'Req')}</span>`;
      return `
        <div class="audit-record-card">
          <div class="audit-name">${escapeHtml(r.name)} &mdash; <span style="font-family:monospace;color:#4f46e5;">${cleanMob}</span></div>
          <div class="audit-meta">By: ${escapeHtml(r.addedBy || 'N/A')} &bull; ${timeStr} &bull; <strong>${r.status}</strong>${extra}</div>
        </div>
      `;
    }).join('');
  }

  modal.classList.remove('hidden-modal');
  if (window.lucide) window.lucide.createIcons();
}

function closeCallsAuditModal() {
  const modal = document.getElementById("calls-audit-modal");
  if (modal) modal.classList.add("hidden-modal");
}

// --- 📱 MOBILE TAB SWITCHER ENGINE (Mobile-First) ---
function switchMobileTab(tabName) {
  // New HTML uses id="tab-queue", "tab-form", "tab-history" with class active-panel
  const panels = {
    queue:   document.getElementById('tab-queue'),
    form:    document.getElementById('tab-form'),
    history: document.getElementById('tab-history')
  };
  const navBtns = {
    queue:   document.getElementById('nav-btn-queue'),
    form:    document.getElementById('nav-btn-form'),
    history: document.getElementById('nav-btn-history')
  };

  // Hide all panels, deactivate all nav buttons
  Object.values(panels).forEach(p => { if (p) p.classList.remove('active-panel'); });
  Object.values(navBtns).forEach(b => { if (b) b.classList.remove('active'); });

  // Show requested panel and activate its nav button
  if (panels[tabName]) panels[tabName].classList.add('active-panel');
  if (navBtns[tabName]) navBtns[tabName].classList.add('active');

  // If switching to history, refresh render
  if (tabName === 'history') renderHistoryTable();
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


// --- DEVICE ID: stable fingerprint from browser properties ---
function getStableDeviceId() {
  try {
    const ua = navigator.userAgent || '';
    const sc = (window.screen.width || 0) + 'x' + (window.screen.height || 0);
    const tz = (Intl && Intl.DateTimeFormat ? Intl.DateTimeFormat().resolvedOptions().timeZone : '') || '';
    const raw = ua + sc + tz;
    let h = 0;
    for (let i = 0; i < raw.length; i++) { h = Math.imul(31, h) + raw.charCodeAt(i) | 0; }
    const id = 'fp_' + Math.abs(h).toString(36);
    try { localStorage.setItem('telecaller_device_id', id); } catch(e){}
    try { sessionStorage.setItem('telecaller_device_id', id); } catch(e){}
    return id;
  } catch(e) {
    let id = '';
    try { id = localStorage.getItem('telecaller_device_id') || sessionStorage.getItem('telecaller_device_id') || ''; } catch(e2){}
    if (!id) { 
      id = 'dev_' + Math.random().toString(36).slice(2, 10); 
      try { localStorage.setItem('telecaller_device_id', id); } catch(e3){}
      try { sessionStorage.setItem('telecaller_device_id', id); } catch(e3){}
    }
    return id;
  }
}

// --- AUTH CHECK: show or hide the login modal ---
function checkCallerSecurityAccess() {
  let token = '', name = '', role = 'Caller';
  try { token = localStorage.getItem('telecaller_auth_token') || sessionStorage.getItem('telecaller_auth_token'); } catch(e){}
  try { name = localStorage.getItem('telecaller_agent_name') || sessionStorage.getItem('telecaller_agent_name'); } catch(e){}
  try { role = localStorage.getItem('telecaller_user_role') || sessionStorage.getItem('telecaller_user_role') || 'Caller'; } catch(e){}

  const isAuth = (token === 'TRUE') && name && name.length > 0;

  const modal      = document.getElementById('security-auth-modal');
  const badgeName  = document.getElementById('logged-user-name');
  const agentInput = document.getElementById('caller-name');
  const exportBtn  = document.getElementById('export-csv-btn');
  const uploadLabel= document.querySelector('label[for="excel-file-input"]');
  const uploadInput= document.getElementById('excel-file-input');
  const clearBtn   = document.getElementById('clear-queue-btn');

  if (!isAuth) {
    if (modal) modal.classList.remove('hidden');
    if (badgeName) badgeName.innerText = 'Locked';
    return;
  }

  // ✅ Authenticated — hide modal and set up UI
  if (modal) modal.classList.add('hidden');
  if (badgeName) badgeName.innerText = name + (role === 'Admin' ? ' 👑' : '');
  if (agentInput) agentInput.value = name;

  const isAdmin = (role === 'Admin');
  if (exportBtn)   exportBtn.style.display   = isAdmin ? 'inline-flex' : 'none';
  if (uploadLabel) uploadLabel.style.display = isAdmin ? 'flex' : 'none';
  if (clearBtn)    clearBtn.style.display    = isAdmin ? 'flex' : 'none';
  if (uploadInput) uploadInput.style.display = 'none';

  fetchCentralLeadQueue();
}

// --- LOGIN HANDLER (Firebase) ---
async function handleCallerLogin(event) {
  event.preventDefault();

  const nameInput = document.getElementById('auth-caller-name');
  const pinInput  = document.getElementById('auth-caller-pin');
  const errBox    = document.getElementById('auth-error-msg');
  const submitBtn = document.getElementById('auth-submit-btn');

  const nameVal = (nameInput ? nameInput.value : '').trim();
  const pinVal  = (pinInput  ? pinInput.value  : '').trim();

  if (!nameVal || !pinVal) return;

  // Show loading state
  if (submitBtn) { submitBtn.disabled = true; submitBtn.innerHTML = '<i data-lucide="loader-2" class="spin-icon"></i> Verifying...'; if (window.lucide) window.lucide.createIcons(); }
  if (errBox)    errBox.classList.add('hidden');

  function resetBtn() {
    if (submitBtn) { submitBtn.disabled = false; submitBtn.innerHTML = '<i data-lucide="key-round"></i> Unlock Access'; if (window.lucide) window.lucide.createIcons(); }
  }
  function showErr(msg) {
    resetBtn();
    if (errBox) { errBox.innerText = msg; errBox.classList.remove('hidden'); }
  }

  if (!db) {
    showErr('⛔ Database not connected. Please contact Admin.');
    return;
  }

  const deviceId = getStableDeviceId();

  try {
    const userRef = db.collection('users').doc(nameVal.toLowerCase());
    const userDoc = await userRef.get();

    let userData;

    const PRECONFIGURED_USERS = {
      'admin': { name: 'admin', pin: '1234', role: 'Admin', status: 'Active', boundDevice: '' },
      'jayeeta': { name: 'jayeeta', pin: '4321', role: 'Caller', status: 'Active', boundDevice: '' },
      'moupriya': { name: 'moupriya', pin: '1234', role: 'Caller', status: 'Active', boundDevice: '' },
      'priya': { name: 'priya', pin: '1234', role: 'Caller', status: 'Active', boundDevice: '' },
      'susmita': { name: 'susmita', pin: '4321', role: 'Caller', status: 'Active', boundDevice: '' }
    };

    const cleanUsername = nameVal.toLowerCase().trim();

    if (!userDoc.exists) {
      // Auto-provision recognized user profiles if they don't exist yet in Firestore
      if (PRECONFIGURED_USERS[cleanUsername] && PRECONFIGURED_USERS[cleanUsername].pin === pinVal) {
        userData = { ...PRECONFIGURED_USERS[cleanUsername] };
        await userRef.set(userData);
      } else {
        showErr('Error: Invalid Name or Security PIN.');
        return;
      }
    } else {
      userData = userDoc.data();
      // If PIN or name casing is updated in code for a preconfigured user, auto-sync it
      if (PRECONFIGURED_USERS[cleanUsername] && PRECONFIGURED_USERS[cleanUsername].pin === pinVal) {
        const expectedName = PRECONFIGURED_USERS[cleanUsername].name;
        if (userData.pin !== pinVal || userData.name !== expectedName) {
          userData.pin = pinVal;
          userData.name = expectedName;
          await userRef.update({ pin: pinVal, name: expectedName });
        }
      }
    }

    if (String(userData.pin).trim() !== pinVal) {
      showErr('⛔ Invalid Name or Security PIN.');
      db.collection('audit_logs').add({ timestamp: new Date().toISOString(), callerName: nameVal, eventType: 'FAILED_LOGIN', details: 'Failed PIN attempt from device: ' + deviceId });
      return;
    }

    if (userData.status && userData.status.toLowerCase() !== 'active') {
      showErr('Error: Account Revoked. Please contact Admin.');
      db.collection('audit_logs').add({ timestamp: new Date().toISOString(), callerName: nameVal, eventType: 'BLOCKED_LOGIN', details: 'Attempted login on revoked account from device: ' + deviceId });
      return;
    }

    // Device Binding Check
    let finalBoundDevice = userData.boundDevice || '';
    if (finalBoundDevice && finalBoundDevice !== deviceId && userData.role !== 'Admin') {
      showErr('Error: Unauthorized Device! Your PIN is bound to another phone. Contact Admin.');
      db.collection('audit_logs').add({ timestamp: new Date().toISOString(), callerName: nameVal, eventType: 'UNAUTHORIZED_DEVICE', details: 'Login rejected! PIN used on unauthorized device: ' + deviceId + ' (Bound: ' + finalBoundDevice + ')' });
      return;
    }

    // If no device bound yet, bind it now
    if (!finalBoundDevice && userData.role !== 'Admin') {
      finalBoundDevice = deviceId;
      await userRef.update({ boundDevice: deviceId });
    }

    // Log successful login
    await userRef.update({ lastLogin: new Date().toISOString() });
    db.collection('audit_logs').add({ timestamp: new Date().toISOString(), callerName: userData.name || nameVal, eventType: 'LOGIN', details: 'Logged into app successfully from device: ' + deviceId });

    // ✅ SUCCESS — write token then show app
    const n = userData.name || nameVal;
    const r = userData.role || 'Caller';
    
    try { localStorage.setItem('telecaller_auth_token', 'TRUE'); } catch(e){}
    try { localStorage.setItem('telecaller_agent_name', n); } catch(e){}
    try { localStorage.setItem('telecaller_user_role',  r); } catch(e){}
    try { sessionStorage.setItem('telecaller_auth_token', 'TRUE'); } catch(e){}
    try { sessionStorage.setItem('telecaller_agent_name', n); } catch(e){}
    try { sessionStorage.setItem('telecaller_user_role',  r); } catch(e){}
    
    resetBtn();
    showToast('Access Granted', 'Welcome ' + n + '! System unlocked.', 'success');
    checkCallerSecurityAccess();
    fetchRemoteLogs();

  } catch (err) {
    console.error("Login Error:", err);
    showErr('Error: Could not connect to the server. Check your internet or Firebase config.');
  }
}


function logoutCaller() {
  if (confirm("Are you sure you want to lock and log out of the Telecaller portal?")) {
    const callerName = localStorage.getItem("telecaller_agent_name") || sessionStorage.getItem("telecaller_agent_name") || "Caller";
    try { localStorage.removeItem("telecaller_auth_token"); } catch(e) {}
    try { localStorage.removeItem("telecaller_agent_name"); } catch(e) {}
    try { localStorage.removeItem("telecaller_user_role"); } catch(e) {}
    try { sessionStorage.removeItem("telecaller_auth_token"); } catch(e) {}
    try { sessionStorage.removeItem("telecaller_agent_name"); } catch(e) {}
    try { sessionStorage.removeItem("telecaller_user_role"); } catch(e) {}
    
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
    input.value = sheetUrl || "";
  }
}

function closeSettings() {
  const modal = document.getElementById("settings-modal");
  if (modal) {
    modal.style.display = "none";
    modal.classList.add("hidden-modal");
  }
}

// (saveSettings is defined earlier in this file)

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
window.addEventListener('error', function (e) {
  // Show any uncaught JS errors as a toast so the user can see the message on mobile
  if (typeof showToast === 'function') {
    showToast('JS Error', e.message || String(e), 'error');
  }
  console.error(e);
});

window.addEventListener('unhandledrejection', function (e) {
  const msg = e && e.reason && e.reason.message ? e.reason.message : String(e.reason || e);
  if (typeof showToast === 'function') {
    showToast('Promise Rejection', msg, 'error');
  }
  console.error('Unhandled Promise Rejection:', e);
});
