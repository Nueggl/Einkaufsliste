// ============================================================================
// app.js – Hauptlogik der Echtzeit-Einkaufslisten-App
// Tech-Stack: Vanilla JS (ES6+ Module) + Firebase Modular SDK v10+
// Unterstützt Firestore Echtzeit-Sync (onSnapshot) + IndexedDB Offline-Cache
// sowie permanente Smartphone-Tastatur im Eintrag-Pop-up mit schwebenden Bubbles.
// ============================================================================

import { firebaseConfig } from "./firebase-config.js";

// Firebase v10+ Modulare Imports über das offizielle Google gstatic CDN
import { initializeApp } from "https://www.gstatic.com/firebasejs/10.13.2/firebase-app.js";
import {
  getAuth,
  signInAnonymously,
  onAuthStateChanged
} from "https://www.gstatic.com/firebasejs/10.13.2/firebase-auth.js";
import {
  initializeFirestore,
  persistentLocalCache,
  persistentSingleTabManager,
  collection,
  doc,
  setDoc,
  getDocs,
  updateDoc,
  onSnapshot,
  query,
  where,
  arrayUnion
} from "https://www.gstatic.com/firebasejs/10.13.2/firebase-firestore.js";

// ============================================================================
// 1. KATEGORIEN: "KEINE KATEGORIE" (STANDARD, FARBLOS) + STANDARD-KATEGORIEN
// ============================================================================
export const NO_CATEGORY = {
  id: "cat_none",
  name: "Keine Kategorie",
  color: "", // Wirklich keine Farbe (nicht weiß, sondern komplett farblos/transparent)
  order: 0
};

export const DEFAULT_CATEGORIES = [
  { id: "cat_kuehlung", name: "Kühlung", color: "#7dd3fc", order: 1 },        // hellblau
  { id: "cat_obst_gemuese", name: "Obst & Gemüse", color: "#22c55e", order: 2 }, // grün
  { id: "cat_trockenwaren", name: "Trockenwaren", color: "#991b1b", order: 3 },  // dunkelrot
  { id: "cat_backwaren", name: "Backwaren", color: "#ffffff", order: 4 },        // weiß
  { id: "cat_getraenke", name: "Getränke", color: "#1e3a8a", order: 5 },         // dunkelblau
  { id: "cat_drogerie", name: "Drogerie", color: "#d6c7b2", order: 6 }           // beige
];

// ============================================================================
// 2. GLOBALER APP-ZUSTAND (STATE)
// ============================================================================
const state = {
  isFirebaseConfigured: false,
  db: null,
  auth: null,
  userId: localStorage.getItem("einkaufsliste_local_uid") || generateId("user"),

  // Eigene Kategorien des aktuellen Nutzers (aus Einstellungen)
  ownCategories: [],

  // Alle Listen, bei denen der Nutzer Inhaber oder Teilnehmer ist
  lists: [],
  activeListId: localStorage.getItem("einkaufsliste_last_list_id") || null,

  // Modus: 'list' (Reiner Listenmodus) oder 'edit' (Bearbeitungsmodus)
  mode: "list",

  // Sortierung: 'category' | 'asc' | 'desc'
  sortBy: localStorage.getItem("einkaufsliste_sort_by") || "category",

  // Darkmode
  darkMode: localStorage.getItem("einkaufsliste_darkmode") === "true",

  // Firestore Snapshot-Unsubscribe-Funktionen
  unsubUserProfile: null,
  unsubLists: null,
  unsubActiveListDoc: null,
  subscribedActiveDocId: null,

  // Großes Eintrag-Pop-up Zustand
  popup: {
    isOpen: false,
    editingItemId: null, // null = Neuer Eintrag, sonst ID des bestehenden Eintrags
    name: "",
    quantityNumber: "",
    quantityUnit: "",
    categoryId: NO_CATEGORY.id, // Standardmäßig ist "Keine Kategorie" ausgewählt!
    important: false,

    // Sub-Popups im mittleren Bereich ('none' | 'qty' | 'cat')
    subOverlay: "none",
    // Kategorie-Auswahl-Tab: 'list' ("In dieser Liste") | 'own' ("Eigene Kategorien")
    catTab: "list",
    catPage: 0,
    catPerPage: 8 // Wird dynamisch anhand des echten Platzes berechnet, damit Seite 1 erst voll gemacht wird!
  },

  // Kategorie-Editor-Modal Zustand
  catModal: {
    editingCatId: null,
    fromPopupShortcut: false
  }
};

localStorage.setItem("einkaufsliste_local_uid", state.userId);

// ============================================================================
// 3. HILFSFUNKTIONEN
// ============================================================================
function generateId(prefix = "id") {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).substring(2, 8)}`;
}

function generateSixDigitCode() {
  return Math.floor(100000 + Math.random() * 900000).toString();
}

function showToast(message) {
  const container = document.getElementById("toast-container");
  const toast = document.createElement("div");
  toast.className = "toast";
  toast.textContent = message;
  container.appendChild(toast);
  setTimeout(() => {
    toast.remove();
  }, 2400);
}

function getActiveList() {
  return state.lists.find((l) => l.id === state.activeListId) || null;
}

function setActiveListId(listId) {
  state.activeListId = listId;
  if (listId) {
    localStorage.setItem("einkaufsliste_last_list_id", listId);
  }
  subscribeToActiveListRealtime();
}

/**
 * Liefert alle Kategorien für die Seite "In dieser Liste"
 * (immer inklusive "Keine Kategorie" an erster Stelle).
 */
function getListCategories(list) {
  const map = new Map();
  map.set(NO_CATEGORY.id, NO_CATEGORY);

  if (list && Array.isArray(list.listCategories)) {
    list.listCategories.forEach((c) => {
      if (c && c.id && c.id !== NO_CATEGORY.id) {
        map.set(c.id, c);
      }
    });
  }

  // Falls der aktuelle Nutzer der Inhaber ist, stelle sicher, dass alle seine eigenen Kategorien enthalten sind
  if (!list || list.ownerId === state.userId) {
    state.ownCategories.forEach((c) => {
      if (c && c.id && !map.has(c.id)) {
        map.set(c.id, c);
      }
    });
  }

  if (map.size <= 1) {
    DEFAULT_CATEGORIES.forEach((c) => map.set(c.id, c));
  }

  return Array.from(map.values());
}

/**
 * Liefert alle Kategorien für die Seite "Eigene Kategorien"
 * (ebenfalls immer mit "Keine Kategorie" an erster Stelle).
 */
function getOwnCategoriesWithNone() {
  const map = new Map();
  map.set(NO_CATEGORY.id, NO_CATEGORY);
  state.ownCategories.forEach((c) => {
    if (c && c.id && c.id !== NO_CATEGORY.id) {
      map.set(c.id, c);
    }
  });
  return Array.from(map.values());
}

/**
 * Sucht eine Kategorie nach ID (inkl. "Keine Kategorie" als Standard)
 */
function resolveCategory(categoryId, list = getActiveList()) {
  if (!categoryId || categoryId === NO_CATEGORY.id) {
    return NO_CATEGORY;
  }
  const listCats = getListCategories(list);
  return (
    listCats.find((c) => c.id === categoryId) ||
    state.ownCategories.find((c) => c.id === categoryId) ||
    DEFAULT_CATEGORIES.find((c) => c.id === categoryId) ||
    NO_CATEGORY
  );
}

/**
 * Sorgt dafür, dass im großen Eintrag-Pop-up die Smartphone-Tastatur NIEMALS
 * ungewollt zuklappt – selbst wenn man im Kategorie-Menü auf Buttons klickt!
 */
function keepPopupKeyboardAlive() {
  if (!state.popup.isOpen) return;
  // Wenn das Kategorie-Editor-Modal darüber geöffnet ist, dort fokussieren
  const catModal = document.getElementById("modal-category-editor");
  if (catModal && !catModal.classList.contains("hidden")) {
    return;
  }
  if (state.popup.subOverlay === "qty") {
    const qtyInput = document.getElementById("qty-number-input");
    if (qtyInput && document.activeElement !== qtyInput) {
      qtyInput.focus({ preventScroll: true });
    }
  } else {
    const nameInput = document.getElementById("item-name-input");
    if (nameInput && document.activeElement !== nameInput) {
      nameInput.focus({ preventScroll: true });
    }
  }
}

/**
 * Aktualisiert die CSS-Variable `--vvh` anhand der `window.visualViewport`-Höhe.
 * Dadurch liegen die unteren Buttons ("Menge", "Kategorie", "Wichtig") immer
 * millimetergenau direkt über der ausgeklappten Smartphone-Tastatur!
 */
function setupVisualViewportAdapter() {
  const updateViewportHeight = () => {
    const vh = window.visualViewport ? window.visualViewport.height : window.innerHeight;
    document.documentElement.style.setProperty("--vvh", `${vh}px`);
    if (state.popup.isOpen && state.popup.subOverlay === "cat") {
      renderCategoryOverlay();
    }
  };

  if (window.visualViewport) {
    window.visualViewport.addEventListener("resize", updateViewportHeight);
    window.visualViewport.addEventListener("scroll", updateViewportHeight);
  }
  window.addEventListener("resize", updateViewportHeight);
  updateViewportHeight();
}

// ============================================================================
// 4. FIREBASE INITIALISIERUNG & OFFLINE-PERSISTENZ
// ============================================================================
async function initBackend() {
  const hasRealConfig =
    firebaseConfig &&
    firebaseConfig.apiKey &&
    firebaseConfig.apiKey !== "DEIN_API_KEY" &&
    firebaseConfig.projectId &&
    firebaseConfig.projectId !== "DEIN_PROJEKT";

  const banner = document.getElementById("connection-banner");
  const authStatusText = document.getElementById("auth-status-text");

  if (!hasRealConfig) {
    state.isFirebaseConfigured = false;
    banner.classList.remove("hidden");
    authStatusText.textContent = "Lokaler Offline-Speicher aktiv";
    initLocalStorageFallback();
    return;
  }

  try {
    const app = initializeApp(firebaseConfig);

    // Firestore mit aktivierter IndexedDB Offline-Persistenz initialisieren.
    // WICHTIG für Android WebView & sofortigen Echtzeit-Push:
    // - persistentSingleTabManager({ forceOwnership: true }) vermeidet Multi-Tab-Polling-Delays
    // - experimentalAutoDetectLongPolling: true garantiert stabile Echtzeit-Streams auf Mobilgeräten
    state.db = initializeFirestore(app, {
      localCache: persistentLocalCache({
        tabManager: persistentSingleTabManager({ forceOwnership: true })
      }),
      experimentalAutoDetectLongPolling: true
    });

    state.auth = getAuth(app);
    state.isFirebaseConfigured = true;
    banner.classList.add("hidden");

    // Automatische Anmeldung über Firebase Anonymous Auth
    onAuthStateChanged(state.auth, async (user) => {
      if (user) {
        state.userId = user.uid;
        authStatusText.textContent = "Echtzeit-Sync & Offline-Cache aktiv";
        await subscribeToUserProfileAndLists();
      } else {
        await signInAnonymously(state.auth);
      }
    });
  } catch (err) {
    console.error("Firebase-Initialisierungsfehler, nutze lokalen Modus:", err);
    state.isFirebaseConfigured = false;
    banner.classList.remove("hidden");
    document.getElementById("connection-banner-text").textContent =
      "Firebase nicht erreichbar – Lokaler Offline-Modus aktiv";
    initLocalStorageFallback();
  }
}

// ============================================================================
// 5. DATEN-SYNCHRONISIERUNG (FIRESTORE onSnapshot & LOKALER FALLBACK)
// ============================================================================
const localChannel =
  typeof BroadcastChannel !== "undefined" ? new BroadcastChannel("einkaufsliste_sync") : null;

function initLocalStorageFallback() {
  loadFromLocalStorage();
  if (state.lists.length === 0) {
    createInitialDefaultListLocal();
  }
  renderAll();

  if (localChannel) {
    localChannel.onmessage = () => {
      loadFromLocalStorage();
      renderAll();
    };
  }
}

function loadFromLocalStorage() {
  try {
    const rawCats = localStorage.getItem("einkaufsliste_own_categories");
    const parsedCats = rawCats ? JSON.parse(rawCats) : [...DEFAULT_CATEGORIES];
    state.ownCategories = parsedCats.filter((c) => c && c.id !== NO_CATEGORY.id);

    const rawLists = localStorage.getItem("einkaufsliste_lists_data");
    state.lists = rawLists ? JSON.parse(rawLists) : [];

    if (
      state.lists.length > 0 &&
      (!state.activeListId || !state.lists.some((l) => l.id === state.activeListId))
    ) {
      setActiveListId(state.lists[0].id);
    }
  } catch (e) {
    console.error("Fehler beim Lesen aus LocalStorage:", e);
    state.ownCategories = [...DEFAULT_CATEGORIES];
    state.lists = [];
  }
}

function saveToLocalStorage() {
  localStorage.setItem("einkaufsliste_own_categories", JSON.stringify(state.ownCategories));
  localStorage.setItem("einkaufsliste_lists_data", JSON.stringify(state.lists));
  if (localChannel) {
    localChannel.postMessage({ type: "sync" });
  }
}

function createInitialDefaultListLocal() {
  const newList = {
    id: generateId("list"),
    name: "Meine Einkaufsliste",
    ownerId: state.userId,
    memberIds: [state.userId],
    shareCode: generateSixDigitCode(),
    listCategories: [...state.ownCategories],
    items: [],
    updatedAt: Date.now()
  };
  state.lists.push(newList);
  setActiveListId(newList.id);
  saveToLocalStorage();
}

async function subscribeToUserProfileAndLists() {
  if (!state.isFirebaseConfigured || !state.db) return;

  const userRef = doc(state.db, "users", state.userId);

  // 1. Echtzeit-Listener auf eigene Kategorien des Nutzers
  if (state.unsubUserProfile) state.unsubUserProfile();
  state.unsubUserProfile = onSnapshot(userRef, async (snap) => {
    if (!snap.exists()) {
      const initialCats = [...DEFAULT_CATEGORIES];
      await setDoc(userRef, {
        ownCategories: initialCats,
        updatedAt: Date.now()
      });
      state.ownCategories = initialCats;
    } else {
      const data = snap.data();
      state.ownCategories =
        Array.isArray(data.ownCategories) && data.ownCategories.length > 0
          ? data.ownCategories.filter((c) => c && c.id !== NO_CATEGORY.id)
          : [...DEFAULT_CATEGORIES];
    }
    renderSettingsCategories();
    if (state.popup.isOpen && state.popup.subOverlay === "cat") {
      renderCategoryOverlay();
    }
  });

  // 2. Echtzeit-Listener (`onSnapshot`) auf alle Listen des Nutzers
  if (state.unsubLists) state.unsubLists();
  const listsQuery = query(
    collection(state.db, "lists"),
    where("memberIds", "array-contains", state.userId)
  );

  let initialSnapshotHandled = false;
  state.unsubLists = onSnapshot(
    listsQuery,
    { includeMetadataChanges: true },
    async (querySnap) => {
      const loadedLists = [];
      querySnap.forEach((docSnap) => {
        loadedLists.push({ id: docSnap.id, ...docSnap.data() });
      });

      loadedLists.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
      state.lists = loadedLists;

      if (!initialSnapshotHandled && state.lists.length === 0) {
        initialSnapshotHandled = true;
        await createNewList("Meine Einkaufsliste");
        return;
      }
      initialSnapshotHandled = true;

      if (!state.activeListId || !state.lists.some((l) => l.id === state.activeListId)) {
        if (state.lists.length > 0) {
          setActiveListId(state.lists[0].id);
        }
      } else {
        // Stelle sicher, dass der dedizierte Echtzeit-Dokument-Listener auf die aktive Liste läuft
        subscribeToActiveListRealtime();
      }

      renderAll();
    }
  );
}

/**
 * Aggressiver Echtzeit-Dokument-Listener (`onSnapshot` direkt auf `doc(db, "lists", activeListId)`)
 * mit `includeMetadataChanges: true`.
 * Sobald irgendein Teilnehmer ein Item abhakt oder neu hinzufügt, pusht Firestore das geänderte
 * Dokument unmittelbar an alle anderen Teilnehmer, und die UI aktualisiert sich sofort ohne Menüwechsel!
 */
function subscribeToActiveListRealtime() {
  if (!state.isFirebaseConfigured || !state.db || !state.activeListId) return;

  // Wenn bereits genau diese Liste abonniert ist, nicht unnötig neu verbinden
  if (state.subscribedActiveDocId === state.activeListId && state.unsubActiveListDoc) {
    return;
  }

  if (state.unsubActiveListDoc) {
    state.unsubActiveListDoc();
    state.unsubActiveListDoc = null;
  }

  state.subscribedActiveDocId = state.activeListId;
  const activeDocRef = doc(state.db, "lists", state.activeListId);

  state.unsubActiveListDoc = onSnapshot(
    activeDocRef,
    { includeMetadataChanges: true },
    (docSnap) => {
      if (!docSnap.exists()) return;
      const freshData = { id: docSnap.id, ...docSnap.data() };
      const idx = state.lists.findIndex((l) => l.id === docSnap.id);
      if (idx >= 0) {
        state.lists[idx] = freshData;
      } else {
        state.lists.unshift(freshData);
      }
      renderAll();
      // Falls das Kategorie-Menü im Pop-up gerade offen ist, auch dort live aktualisieren
      if (state.popup.isOpen && state.popup.subOverlay === "cat") {
        renderCategoryOverlay();
      }
    }
  );
}

async function persistList(list) {
  list.updatedAt = Date.now();
  // Sofortiges (optimistisches) lokales UI-Update ohne Verzögerung
  renderAll();

  if (state.isFirebaseConfigured && state.db) {
    const listRef = doc(state.db, "lists", list.id);
    // Klone das Objekt sauber, damit Firestore jede Array-/Item-Änderung (z.B. checked = true/false)
    // sofort als Delta erkennt und augenblicklich an alle verbundenen Geräte sendet!
    const cleanPayload = JSON.parse(JSON.stringify(list));
    await setDoc(listRef, cleanPayload);
  } else {
    saveToLocalStorage();
  }
}

async function persistOwnCategories() {
  if (state.isFirebaseConfigured && state.db) {
    const userRef = doc(state.db, "users", state.userId);
    await setDoc(
      userRef,
      { ownCategories: state.ownCategories, updatedAt: Date.now() },
      { merge: true }
    );

    for (const list of state.lists) {
      if (list.ownerId === state.userId) {
        list.listCategories = mergeCategoriesIntoList(list.listCategories || [], state.ownCategories);
        await persistList(list);
      }
    }
  } else {
    for (const list of state.lists) {
      if (list.ownerId === state.userId) {
        list.listCategories = mergeCategoriesIntoList(
          list.listCategories || [],
          state.ownCategories
        );
      }
    }
    saveToLocalStorage();
    renderAll();
  }
}

function mergeCategoriesIntoList(existingListCats, ownerCats) {
  const map = new Map();
  existingListCats.forEach((c) => {
    if (c && c.id && c.id !== NO_CATEGORY.id) map.set(c.id, { ...c });
  });
  ownerCats.forEach((c) => {
    if (c && c.id && c.id !== NO_CATEGORY.id) map.set(c.id, { ...c });
  });
  return Array.from(map.values());
}

// ============================================================================
// 6. LISTEN ERSTELLEN, UMBENENNEN, TEILEN & BEITRETEN (6-STELLIGER CODE)
// ============================================================================
async function createNewList(name) {
  const cleanName = (name || "Neue Einkaufsliste").trim();
  const newList = {
    id: generateId("list"),
    name: cleanName,
    ownerId: state.userId,
    memberIds: [state.userId],
    shareCode: generateSixDigitCode(),
    listCategories: [...(state.ownCategories.length ? state.ownCategories : DEFAULT_CATEGORIES)],
    items: [],
    createdAt: Date.now(),
    updatedAt: Date.now()
  };

  setActiveListId(newList.id);

  if (state.isFirebaseConfigured && state.db) {
    await setDoc(doc(state.db, "lists", newList.id), newList);
  } else {
    state.lists.unshift(newList);
    saveToLocalStorage();
    renderAll();
  }
  showToast(`Liste "${cleanName}" erstellt`);
}

async function joinListByCode(codeInput) {
  const code = codeInput.trim().toUpperCase();
  if (code.length !== 6) {
    showToast("Bitte einen 6-stelligen Code eingeben.");
    return false;
  }

  if (state.isFirebaseConfigured && state.db) {
    const q = query(collection(state.db, "lists"), where("shareCode", "==", code));
    const snap = await getDocs(q);
    if (snap.empty) {
      showToast("Keine Liste mit diesem Code gefunden.");
      return false;
    }
    const targetDoc = snap.docs[0];
    const listData = targetDoc.data();
    if (!listData.memberIds.includes(state.userId)) {
      await updateDoc(doc(state.db, "lists", targetDoc.id), {
        memberIds: arrayUnion(state.userId),
        updatedAt: Date.now()
      });
    }
    setActiveListId(targetDoc.id);
    showToast(`Liste "${listData.name}" beigetreten!`);
    return true;
  } else {
    const found = state.lists.find((l) => (l.shareCode || "").toUpperCase() === code);
    if (!found) {
      showToast("Keine Liste mit diesem Code gefunden.");
      return false;
    }
    if (!found.memberIds.includes(state.userId)) {
      found.memberIds.push(state.userId);
    }
    setActiveListId(found.id);
    saveToLocalStorage();
    renderAll();
    showToast(`Liste "${found.name}" beigetreten!`);
    return true;
  }
}

async function saveListNameIfChanged() {
  const list = getActiveList();
  if (!list) return;
  const input = document.getElementById("list-title-input");
  const newName = input.value.trim();
  if (newName && newName !== list.name) {
    list.name = newName;
    await persistList(list);
    showToast("Listenname gespeichert");
  }
}

// ============================================================================
// 7. RENDER-FUNKTIONEN (HAUPTANSICHT, DRAWER, EINSTELLUNGEN)
// ============================================================================
function renderAll() {
  applyTheme();
  renderHeaderAndToolbar();
  renderShoppingList();
  renderDrawerLists();
  renderSettingsCategories();
}

function applyTheme() {
  document.body.classList.toggle("dark-mode", state.darkMode);
  const toggle = document.getElementById("toggle-darkmode");
  if (toggle) toggle.checked = state.darkMode;
}

function renderHeaderAndToolbar() {
  const list = getActiveList();
  const titleDisplay = document.getElementById("list-title-display");
  const titleInput = document.getElementById("list-title-input");
  const modeBtn = document.getElementById("btn-mode-toggle");
  const modeLabel = document.getElementById("mode-toggle-label");
  const clearCheckedBtn = document.getElementById("btn-clear-checked");

  const listName = list ? list.name : "Keine Liste";
  titleDisplay.textContent = listName;
  if (document.activeElement !== titleInput) {
    titleInput.value = listName;
  }

  const isEdit = state.mode === "edit";
  titleDisplay.classList.toggle("hidden", isEdit);
  titleInput.classList.toggle("hidden", !isEdit);
  modeBtn.classList.toggle("edit-active", isEdit);
  modeLabel.textContent = isEdit ? "Fertig" : "Bearbeiten";

  document.querySelectorAll(".sort-btn").forEach((btn) => {
    btn.classList.toggle("active", btn.dataset.sort === state.sortBy);
  });

  const hasChecked = list && Array.isArray(list.items) && list.items.some((i) => i.checked);
  clearCheckedBtn.classList.toggle("hidden", !hasChecked);
}

function renderShoppingList() {
  const container = document.getElementById("list-container");
  container.innerHTML = "";

  const list = getActiveList();
  if (!list || !Array.isArray(list.items) || list.items.length === 0) {
    container.innerHTML = `
      <div class="empty-state">
        <div class="empty-state-icon">🧺</div>
        <h3>Deine Einkaufsliste ist noch leer</h3>
        <p>Tippe unten rechts auf das <strong>+</strong> Symbol, um Einträge hinzuzufügen.</p>
      </div>
    `;
    return;
  }

  const items = [...list.items];

  if (state.sortBy === "category") {
    const groupsMap = new Map();
    const listCats = getListCategories(list);

    // Zuerst alle echten Kategorien, und "Keine Kategorie" ebenfalls als eigene Gruppe
    listCats.forEach((cat) => {
      groupsMap.set(cat.id, { category: cat, items: [] });
    });

    items.forEach((item) => {
      const cat = resolveCategory(item.categoryId, list);
      if (!groupsMap.has(cat.id)) {
        groupsMap.set(cat.id, { category: cat, items: [] });
      }
      groupsMap.get(cat.id).items.push(item);
    });

    groupsMap.forEach(({ category, items: groupItems }) => {
      if (groupItems.length === 0) return;

      groupItems.sort((a, b) => {
        if (Boolean(a.checked) !== Boolean(b.checked)) return a.checked ? 1 : -1;
        if (Boolean(a.important) !== Boolean(b.important)) return a.important ? -1 : 1;
        return (a.name || "").localeCompare(b.name || "", "de");
      });

      const groupEl = document.createElement("section");
      groupEl.className = "category-group";

      const headerEl = document.createElement("div");
      headerEl.className = "category-group-header";
      const hasColor = Boolean(category.color);
      headerEl.innerHTML = `
        ${
          hasColor
            ? `<span class="category-group-dot" style="background-color: ${category.color}"></span>`
            : ""
        }
        <span>${escapeHtml(category.name)}</span>
      `;
      groupEl.appendChild(headerEl);

      const stackEl = document.createElement("div");
      stackEl.className = "items-stack";
      groupItems.forEach((item) => {
        stackEl.appendChild(createItemElement(item, category));
      });

      groupEl.appendChild(stackEl);
      container.appendChild(groupEl);
    });
  } else {
    // Alphabetisch (A-Z) oder Anti-Alphabetisch (Z-A)
    const dir = state.sortBy === "asc" ? 1 : -1;
    items.sort((a, b) => {
      if (Boolean(a.checked) !== Boolean(b.checked)) return a.checked ? 1 : -1;
      return (a.name || "").localeCompare(b.name || "", "de") * dir;
    });

    const stackEl = document.createElement("div");
    stackEl.className = "items-stack";
    items.forEach((item) => {
      const category = resolveCategory(item.categoryId, list);
      stackEl.appendChild(createItemElement(item, category));
    });
    container.appendChild(stackEl);
  }
}

/**
 * Erzeugt ein einzelnes Listen-Element:
 * - Hat die Kategorie eine Farbe, wird links am Rand der dünne Farb-Streifen angezeigt.
 * - Ist "Keine Kategorie" gewählt (`category.color === ""`), hat der Eintrag gar keine Farbe (transparent).
 */
function createItemElement(item, category) {
  const row = document.createElement("div");
  row.className = `list-item${item.checked ? " checked" : ""}${item.important ? " important" : ""}`;

  const stripeColor = category.color ? category.color : "transparent";
  const isWhiteStripe =
    category.color && category.color.toLowerCase() === "#ffffff";
  row.style.setProperty("--stripe-color", stripeColor);

  const qtyText = formatQuantity(item.quantityNumber, item.quantityUnit);

  row.innerHTML = `
    <span class="item-category-stripe${isWhiteStripe ? " stripe-white" : ""}" title="${escapeHtml(category.name)}"></span>
    ${item.important ? '<span class="item-important-bang" title="Wichtig">!</span>' : ""}
    <span class="item-checkbox" role="checkbox" aria-checked="${Boolean(item.checked)}">
      ${
        item.checked
          ? `<svg viewBox="0 0 24 24" width="15" height="15" stroke="currentColor" stroke-width="3" fill="none" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"></polyline></svg>`
          : ""
      }
    </span>
    <div class="item-content">
      <span class="item-name">${escapeHtml(item.name)}</span>
      ${qtyText ? `<span class="item-qty-badge">${escapeHtml(qtyText)}</span>` : ""}
    </div>
    ${
      state.mode === "edit"
        ? `
      <div class="item-edit-actions">
        <button type="button" class="item-action-btn edit" title="Bearbeiten">✎</button>
        <button type="button" class="item-action-btn delete" title="Löschen">🗑</button>
      </div>
    `
        : ""
    }
  `;

  row.addEventListener("click", async (e) => {
    const deleteBtn = e.target.closest(".item-action-btn.delete");
    if (deleteBtn) {
      e.stopPropagation();
      await deleteItem(item.id);
      return;
    }

    const checkboxEl = e.target.closest(".item-checkbox");
    if (state.mode === "edit" && !checkboxEl) {
      openItemPopup(item);
    } else {
      await toggleItemChecked(item.id);
    }
  });

  return row;
}

function formatQuantity(num, unit) {
  const n = (num || "").toString().trim();
  const u = (unit || "").toString().trim();
  if (!n) return "";
  return u ? `${n} ${u}` : n;
}

function escapeHtml(str) {
  return String(str || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

async function toggleItemChecked(itemId) {
  const list = getActiveList();
  if (!list) return;
  const target = list.items.find((i) => i.id === itemId);
  if (!target) return;
  target.checked = !target.checked;
  await persistList(list);
}

async function deleteItem(itemId) {
  const list = getActiveList();
  if (!list) return;
  list.items = list.items.filter((i) => i.id !== itemId);
  await persistList(list);
  showToast("Eintrag gelöscht");
}

async function clearCheckedItems() {
  const list = getActiveList();
  if (!list) return;
  const before = list.items.length;
  list.items = list.items.filter((i) => !i.checked);
  if (list.items.length < before) {
    await persistList(list);
    showToast("Abgehakte Einträge entfernt");
  }
}

// ============================================================================
// 8. DRAWER (SEITENMENÜ) & EINSTELLUNGEN RENDERN
// ============================================================================
function renderDrawerLists() {
  const ul = document.getElementById("drawer-lists");
  if (!ul) return;
  ul.innerHTML = "";

  state.lists.forEach((list) => {
    const li = document.createElement("li");
    li.className = `drawer-list-item${list.id === state.activeListId ? " active" : ""}`;
    const openCount = (list.items || []).filter((i) => !i.checked).length;
    const isOwner = list.ownerId === state.userId;

    li.innerHTML = `
      <div>
        <div>${escapeHtml(list.name)}</div>
        <div class="drawer-list-meta">${isOwner ? "Inhaber" : "Geteilt"} · Code: ${escapeHtml(list.shareCode || "------")}</div>
      </div>
      <span class="item-qty-badge">${openCount} offen</span>
    `;

    li.addEventListener("click", () => {
      setActiveListId(list.id);
      closeDrawer();
      renderAll();
    });

    ul.appendChild(li);
  });
}

function renderSettingsCategories() {
  const container = document.getElementById("settings-categories-list");
  if (!container) return;
  container.innerHTML = "";

  state.ownCategories.forEach((cat) => {
    const item = document.createElement("div");
    item.className = "setting-cat-item";
    item.innerHTML = `
      <div class="setting-cat-left">
        <span class="cat-dot" style="background-color: ${cat.color || "transparent"}"></span>
        <span>${escapeHtml(cat.name)}</span>
      </div>
      <span class="drawer-list-meta">Bearbeiten ✎</span>
    `;
    item.addEventListener("click", () => {
      openCategoryEditorModal(cat, false);
    });
    container.appendChild(item);
  });
}

// ============================================================================
// 9. GROSSES EINTRAG-POP-UP (IMMER AUSGEKLAPPTE TASTATUR & BUBBLE-MENÜS)
// ============================================================================
function openItemPopup(existingItem = null) {
  state.popup.isOpen = true;
  state.popup.subOverlay = "none";
  state.popup.catTab = "list";
  state.popup.catPage = 0;

  if (existingItem) {
    state.popup.editingItemId = existingItem.id;
    state.popup.name = existingItem.name || "";
    state.popup.quantityNumber = existingItem.quantityNumber || "";
    state.popup.quantityUnit = existingItem.quantityUnit || "";
    // Falls keine Kategorie gesetzt war -> "Keine Kategorie" (cat_none)
    state.popup.categoryId = existingItem.categoryId || NO_CATEGORY.id;
    state.popup.important = Boolean(existingItem.important);
  } else {
    state.popup.editingItemId = null;
    state.popup.name = "";
    state.popup.quantityNumber = "";
    state.popup.quantityUnit = "";
    // Standardmäßig "Keine Kategorie" (farblos) ausgewählt!
    state.popup.categoryId = NO_CATEGORY.id;
    state.popup.important = false;
  }

  document.getElementById("item-popup-backdrop").classList.remove("hidden");
  const nameInput = document.getElementById("item-name-input");
  nameInput.value = state.popup.name;

  updatePopupUI();
  // Sofort fokussieren, damit die Smartphone-Tastatur aufgeklappt wird und bleibt
  nameInput.focus();
}

function closeItemPopup() {
  const nameInput = document.getElementById("item-name-input");
  if (!state.popup.editingItemId && nameInput.value.trim().length > 0) {
    commitCurrentPopupItem(false);
  }
  state.popup.isOpen = false;
  state.popup.subOverlay = "none";
  document.getElementById("item-popup-backdrop").classList.add("hidden");
}

function updatePopupUI() {
  const isEditing = Boolean(state.popup.editingItemId);
  const isQtyOpen = state.popup.subOverlay === "qty";
  const isCatOpen = state.popup.subOverlay === "cat";

  document.getElementById("popup-mode-indicator").textContent = isEditing
    ? "Eintrag bearbeiten"
    : "Neuer Eintrag";

  // 1. Linker Slot: Menge (Im geschlossenen Zustand Button + optionales X;
  //    im geöffneten Zustand wird der Button selbst zum Zahlen-Textfeld wie in Skizze 2!)
  const qtySlot = document.getElementById("qty-pill-slot");
  const qtyBtn = document.getElementById("btn-open-qty");
  const qtyLabel = document.getElementById("btn-qty-label");
  const clearQtyBtn = document.getElementById("btn-clear-qty");
  const qtyInlineEditor = document.getElementById("qty-inline-editor");
  const formattedQty = formatQuantity(state.popup.quantityNumber, state.popup.quantityUnit);

  qtySlot.classList.toggle("bubble-active", isQtyOpen);

  if (isQtyOpen) {
    // Button wird direkt zum Zahlen-Eingabefeld!
    qtyBtn.classList.add("hidden");
    clearQtyBtn.classList.add("hidden");
    qtyInlineEditor.classList.remove("hidden");
  } else {
    qtyInlineEditor.classList.add("hidden");
    qtyBtn.classList.remove("hidden");
    if (formattedQty) {
      qtyLabel.textContent = formattedQty;
      qtyBtn.classList.add("has-value");
      clearQtyBtn.classList.remove("hidden");
    } else {
      qtyLabel.textContent = "Menge";
      qtyBtn.classList.remove("has-value");
      clearQtyBtn.classList.add("hidden");
    }
  }

  // 2. Rechter Slot: Kategorie (Bleibt als verbundener Fuß der Kategorie-Bubble erhalten wie in Skizze 1!)
  const catSlot = document.getElementById("cat-pill-slot");
  const catBtn = document.getElementById("btn-open-cat");
  const catLabel = document.getElementById("btn-cat-label");
  const catDot = document.getElementById("btn-cat-color-dot");
  const cat = resolveCategory(state.popup.categoryId);

  catSlot.classList.toggle("bubble-active", isCatOpen);
  catBtn.classList.toggle("has-value", cat.id !== NO_CATEGORY.id);
  catLabel.textContent = cat.id === NO_CATEGORY.id ? "Kategorie" : cat.name;

  if (cat.color) {
    catDot.style.backgroundColor = cat.color;
    catDot.classList.remove("hidden");
  } else {
    // "Keine Kategorie" -> wirklich keine Farbe!
    catDot.classList.add("hidden");
  }

  // 3. Wichtig-Button ganz unten direkt über der Tastatur
  const impBtn = document.getElementById("btn-toggle-important");
  impBtn.classList.toggle("active", state.popup.important);
  impBtn.setAttribute("aria-pressed", String(state.popup.important));

  // 4. Schwebende Bubbles im mittleren Bereich ein-/ausblenden
  document.getElementById("qty-Bubble-panel").classList.toggle("hidden", !isQtyOpen);
  document.getElementById("cat-bubble-panel").classList.toggle("hidden", !isCatOpen);

  // Bearbeiten-Aktionen in der Mitte nur einblenden, wenn kein Sub-Popup offen ist
  document
    .getElementById("popup-edit-actions")
    .classList.toggle("hidden", !isEditing || isQtyOpen || isCatOpen);
}

/**
 * Speichert den aktuellen Eintrag und bereitet – falls `prepareNext = true` –
 * sofort den nächsten Eintrag vor, ohne dass die Smartphone-Tastatur zuklappt!
 */
async function commitCurrentPopupItem(prepareNext = true) {
  // Falls der Nutzer gerade noch eine Zahl im offenen Mengen-Feld eingetippt hat, übernehmen
  if (state.popup.subOverlay === "qty") {
    const rawQty = document.getElementById("qty-number-input").value.trim();
    if (rawQty) {
      state.popup.quantityNumber = rawQty;
    }
    state.popup.subOverlay = "none";
  }

  const nameInput = document.getElementById("item-name-input");
  const trimmedName = nameInput.value.trim();

  if (!trimmedName) {
    if (!prepareNext) return;
    showToast("Bitte gib oben einen Namen für den Eintrag ein.");
    nameInput.focus();
    return;
  }

  const list = getActiveList();
  if (!list) return;

  const chosenCat = resolveCategory(state.popup.categoryId, list);
  if (chosenCat.id !== NO_CATEGORY.id) {
    if (!list.listCategories) list.listCategories = [];
    if (!list.listCategories.some((c) => c.id === chosenCat.id)) {
      list.listCategories.push({ ...chosenCat });
    }
  }

  if (state.popup.editingItemId) {
    const target = list.items.find((i) => i.id === state.popup.editingItemId);
    if (target) {
      target.name = trimmedName;
      target.quantityNumber = state.popup.quantityNumber;
      target.quantityUnit = state.popup.quantityUnit;
      target.categoryId = state.popup.categoryId;
      target.important = state.popup.important;
    }

    if (prepareNext) {
      state.popup.editingItemId = null;
      resetPopupFieldsKeepKeyboard();
    } else {
      state.popup.isOpen = false;
      document.getElementById("item-popup-backdrop").classList.add("hidden");
    }

    showToast("Eintrag aktualisiert");
    // Sofort mit der Datenbank synchronisieren (ohne die UI zu blockieren)
    persistList(list);
  } else {
    const newItem = {
      id: generateId("item"),
      name: trimmedName,
      quantityNumber: state.popup.quantityNumber,
      quantityUnit: state.popup.quantityUnit,
      categoryId: state.popup.categoryId || NO_CATEGORY.id,
      important: state.popup.important,
      checked: false,
      createdAt: Date.now()
    };
    list.items.push(newItem);

    if (prepareNext) {
      resetPopupFieldsKeepKeyboard();
      showToast(`"${trimmedName}" gespeichert & synchronisiert`);
    }

    // Direkt bei jedem angelegten Eintrag die Echtzeit-Synchronisation anstoßen!
    persistList(list);
  }
}

function resetPopupFieldsKeepKeyboard() {
  state.popup.name = "";
  state.popup.quantityNumber = "";
  state.popup.quantityUnit = "";
  state.popup.important = false;
  // Standardmäßig wieder "Keine Kategorie" ausgewählt!
  state.popup.categoryId = NO_CATEGORY.id;
  state.popup.subOverlay = "none";

  const nameInput = document.getElementById("item-name-input");
  nameInput.value = "";
  updatePopupUI();
  nameInput.focus();
}

// ============================================================================
// 10. MENGEN-BUBBLE & DIREKTES ZAHLENFELD (SKIZZE 2)
// ============================================================================
function toggleQuantityOverlay() {
  state.popup.name = document.getElementById("item-name-input").value;

  if (state.popup.subOverlay === "qty") {
    // Wenn schon offen: Zahl übernehmen und schließen
    const rawNumber = document.getElementById("qty-number-input").value.trim();
    if (rawNumber) {
      state.popup.quantityNumber = rawNumber;
    }
    state.popup.subOverlay = "none";
    updatePopupUI();
    document.getElementById("item-name-input").focus();
    return;
  }

  state.popup.subOverlay = "qty";
  updatePopupUI();

  const qtyInput = document.getElementById("qty-number-input");
  const errorHint = document.getElementById("qty-error-hint");
  errorHint.classList.add("hidden");
  qtyInput.value = state.popup.quantityNumber || "";

  // Fokus ins direkte Zahlen-Textfeld unten links -> Tastatur wechselt in den Zahlenmodus
  qtyInput.focus();
  qtyInput.select();
}

function confirmQuantitySelection(unit = "") {
  const qtyInput = document.getElementById("qty-number-input");
  const errorHint = document.getElementById("qty-error-hint");
  const rawNumber = qtyInput.value.trim();

  if (!rawNumber) {
    errorHint.classList.remove("hidden");
    qtyInput.focus();
    return;
  }

  errorHint.classList.add("hidden");
  state.popup.quantityNumber = rawNumber;
  state.popup.quantityUnit = unit;
  state.popup.subOverlay = "none";
  updatePopupUI();

  // Fokus sofort zurück ins Namensfeld oben -> Tastatur bleibt offen!
  document.getElementById("item-name-input").focus();
}

// ============================================================================
// 11. KATEGORIE-BUBBLE (SKIZZE 1: TASTATUR BLEIBT OFFEN & SEITE ERST VOLL MACHEN!)
// ============================================================================
function toggleCategoryOverlay() {
  state.popup.name = document.getElementById("item-name-input").value;

  if (state.popup.subOverlay === "cat") {
    state.popup.subOverlay = "none";
    updatePopupUI();
    keepPopupKeyboardAlive();
    return;
  }

  state.popup.subOverlay = "cat";
  state.popup.catTab = "list"; // Standardmäßig zuerst "In dieser Liste"
  state.popup.catPage = 0;
  updatePopupUI();
  renderCategoryOverlay();
  // Wichtig: Fokus im Namens-Input halten, damit die Smartphone-Tastatur ausgeklappt bleibt!
  keepPopupKeyboardAlive();
}

/**
 * Berechnet dynamisch, wie viele Kategorien auf eine Seite im schwebenden Kategorie-Pop-up
 * passen, damit eine neue Seite wirklich erst dann angelegt wird, wenn die erste Seite voll ist!
 */
function calculateCategoriesPerPage(totalCount) {
  const grid = document.getElementById("cat-grid");
  if (!grid) return 10;
  const availableHeight = grid.clientHeight;
  if (!availableHeight || availableHeight < 80) {
    return 10; // Mindestens 10 Kategorien auf Seite 1, wenn Höhe noch initialisiert wird
  }
  const rowHeight = 42;
  const rowGap = 8;
  const fittingRows = Math.max(2, Math.floor((availableHeight + rowGap) / (rowHeight + rowGap)));
  return fittingRows * 2; // 2 Spalten pro Zeile
}

function renderCategoryOverlay() {
  const list = getActiveList();
  const isListTab = state.popup.catTab === "list";

  document.getElementById("tab-cat-list").classList.toggle("active", isListTab);
  document.getElementById("tab-cat-own").classList.toggle("active", !isListTab);

  // Seite 1: "In dieser Liste" (inkl. "Keine Kategorie" + alle Kategorien des Inhabers/der Liste)
  // Seite 2: "Eigene" (inkl. "Keine Kategorie" + eigene Kategorien)
  const sourceCategories = isListTab
    ? getListCategories(list)
    : getOwnCategoriesWithNone();

  const paginationEl = document.getElementById("cat-pagination");

  // Berechne wie viele Slots in das sichtbare Grid passen
  const perPage = calculateCategoriesPerPage(sourceCategories.length);
  state.popup.catPerPage = perPage;

  const totalPages = Math.max(1, Math.ceil(sourceCategories.length / perPage));
  if (state.popup.catPage >= totalPages) {
    state.popup.catPage = totalPages - 1;
  }

  // Paginierungs-Leiste überhaupt nur einblenden, wenn Seite 1 wirklich voll ist (> 1 Seite)
  paginationEl.classList.toggle("hidden", totalPages <= 1);

  const startIdx = state.popup.catPage * perPage;
  const visibleCats = sourceCategories.slice(startIdx, startIdx + perPage);

  const grid = document.getElementById("cat-grid");
  grid.innerHTML = "";

  visibleCats.forEach((cat) => {
    const btn = document.createElement("button");
    btn.type = "button";
    const isSelected = cat.id === state.popup.categoryId;
    const isWhite = cat.color && cat.color.toLowerCase() === "#ffffff";
    btn.className = `cat-choice-btn${isSelected ? " selected" : ""}`;
    btn.style.setProperty("--cat-color", cat.color || "transparent");

    btn.innerHTML = `
      <span class="cat-choice-stripe${isWhite ? " stripe-white" : ""}"></span>
      <span>${escapeHtml(cat.name)}</span>
    `;

    // Verhindere Fokus-Verlust beim Antippen, damit die Smartphone-Tastatur niemals zuklappt!
    btn.addEventListener("pointerdown", (e) => {
      e.preventDefault();
    });

    btn.addEventListener("click", () => {
      state.popup.categoryId = cat.id;
      state.popup.subOverlay = "none";
      updatePopupUI();
      keepPopupKeyboardAlive();
    });
    grid.appendChild(btn);
  });

  const prevBtn = document.getElementById("btn-cat-prev-page");
  const nextBtn = document.getElementById("btn-cat-next-page");
  const pageInd = document.getElementById("cat-page-indicator");

  prevBtn.disabled = state.popup.catPage <= 0;
  nextBtn.disabled = state.popup.catPage >= totalPages - 1;
  pageInd.textContent = `Seite ${state.popup.catPage + 1} / ${totalPages}`;
}

// ============================================================================
// 12. KATEGORIE ANLEGEN / BEARBEITEN (EINSTELLUNGEN & POP-UP SHORTCUT)
// ============================================================================
function openCategoryEditorModal(existingCat = null, fromPopupShortcut = false) {
  state.catModal.editingCatId = existingCat ? existingCat.id : null;
  state.catModal.fromPopupShortcut = fromPopupShortcut;

  const titleEl = document.getElementById("cat-modal-title");
  const nameInput = document.getElementById("input-cat-name");
  const colorInput = document.getElementById("input-cat-color");
  const deleteBtn = document.getElementById("btn-delete-category");

  titleEl.textContent = existingCat ? "Kategorie bearbeiten" : "Neue Kategorie anlegen";
  nameInput.value = existingCat ? existingCat.name : "";
  colorInput.value = normalizeHexColor(existingCat ? existingCat.color : "#60a5fa");

  deleteBtn.classList.toggle("hidden", !existingCat || state.ownCategories.length <= 1);

  document.getElementById("modal-category-editor").classList.remove("hidden");
  nameInput.focus();
}

function normalizeHexColor(c) {
  if (typeof c === "string" && /^#[0-9a-fA-F]{6}$/.test(c)) return c;
  return "#60a5fa";
}

async function handleSaveCategoryForm(e) {
  e.preventDefault();
  const name = document.getElementById("input-cat-name").value.trim();
  const color = document.getElementById("input-cat-color").value;
  if (!name) return;

  let targetCat = null;

  if (state.catModal.editingCatId) {
    targetCat = state.ownCategories.find((c) => c.id === state.catModal.editingCatId);
    if (targetCat) {
      targetCat.name = name;
      targetCat.color = color;
    }
    const list = getActiveList();
    if (list && Array.isArray(list.listCategories)) {
      const listCat = list.listCategories.find((c) => c.id === state.catModal.editingCatId);
      if (listCat) {
        listCat.name = name;
        listCat.color = color;
        await persistList(list);
      }
    }
  } else {
    targetCat = {
      id: generateId("cat"),
      name,
      color,
      order: state.ownCategories.length + 1
    };
    state.ownCategories.push(targetCat);

    const list = getActiveList();
    if (list) {
      if (!list.listCategories) list.listCategories = [];
      if (!list.listCategories.some((c) => c.id === targetCat.id)) {
        list.listCategories.push({ ...targetCat });
        await persistList(list);
      }
    }
  }

  await persistOwnCategories();
  document.getElementById("modal-category-editor").classList.add("hidden");

  if (state.catModal.fromPopupShortcut && targetCat) {
    state.popup.categoryId = targetCat.id;
    state.popup.subOverlay = "none";
    updatePopupUI();
    keepPopupKeyboardAlive();
  }

  showToast(`Kategorie "${name}" gespeichert`);
}

async function handleDeleteCategory() {
  const id = state.catModal.editingCatId;
  if (!id || state.ownCategories.length <= 1) return;
  state.ownCategories = state.ownCategories.filter((c) => c.id !== id);
  await persistOwnCategories();
  document.getElementById("modal-category-editor").classList.add("hidden");
  showToast("Kategorie gelöscht");
}

// ============================================================================
// 13. EVENT-LISTENER & TASTATUR-SCHUTZ IM POP-UP
// ============================================================================
function openDrawer() {
  document.getElementById("drawer-backdrop").classList.remove("hidden");
  const drawer = document.getElementById("side-drawer");
  drawer.classList.add("open");
  drawer.setAttribute("aria-hidden", "false");
}

function closeDrawer() {
  document.getElementById("drawer-backdrop").classList.add("hidden");
  const drawer = document.getElementById("side-drawer");
  drawer.classList.remove("open");
  drawer.setAttribute("aria-hidden", "true");
}

/**
 * Verhindert bei Buttons im großen Eintrag-Pop-up, dass das Antippen dem
 * Textfeld den Fokus entzieht (wodurch Android sonst die Tastatur einklappen würde).
 */
function preventKeyboardBlurOnButtons() {
  const popup = document.getElementById("item-popup");
  popup.addEventListener("pointerdown", (e) => {
    const isInput = e.target.closest("input, textarea");
    if (!isInput) {
      e.preventDefault();
      keepPopupKeyboardAlive();
    }
  });
}

function bindEvents() {
  preventKeyboardBlurOnButtons();

  // 1. Top-Bar Menü (3 horizontale Striche oben links)
  document.getElementById("btn-menu").addEventListener("click", openDrawer);
  document.getElementById("btn-close-drawer").addEventListener("click", closeDrawer);
  document.getElementById("drawer-backdrop").addEventListener("click", closeDrawer);

  // 2. Modus-Wechsel: Listenmodus <-> Bearbeitungsmodus
  document.getElementById("btn-mode-toggle").addEventListener("click", async () => {
    if (state.mode === "edit") {
      await saveListNameIfChanged();
      state.mode = "list";
    } else {
      state.mode = "edit";
    }
    renderAll();
  });

  document.getElementById("list-title-input").addEventListener("keydown", async (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      await saveListNameIfChanged();
      e.target.blur();
    }
  });

  // 3. Sortier-Steuerung (Kategorie, A-Z, Z-A)
  document.querySelectorAll(".sort-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      state.sortBy = btn.dataset.sort;
      localStorage.setItem("einkaufsliste_sort_by", state.sortBy);
      renderAll();
    });
  });

  document.getElementById("btn-clear-checked").addEventListener("click", clearCheckedItems);

  // 4. Floating Action Button (+) unten rechts
  document.getElementById("fab-add-item").addEventListener("click", () => {
    openItemPopup(null);
  });

  // 5. Großes Eintrag-Pop-up Steuerung
  document.getElementById("btn-popup-close").addEventListener("click", closeItemPopup);
  document.getElementById("btn-popup-next").addEventListener("click", () => {
    commitCurrentPopupItem(true);
  });

  // Wenn man oben ins Namensfeld tippt, während Menge oder Kategorie offen ist -> Sub-Bubble schließen
  document.getElementById("item-name-input").addEventListener("pointerdown", () => {
    if (state.popup.subOverlay !== "none") {
      if (state.popup.subOverlay === "qty") {
        const rawQty = document.getElementById("qty-number-input").value.trim();
        if (rawQty) state.popup.quantityNumber = rawQty;
      }
      state.popup.subOverlay = "none";
      updatePopupUI();
    }
  });

  // Enter-Taste im Eintragsnamen-Feld -> Nächster Eintrag (Tastatur bleibt offen)
  document.getElementById("item-name-input").addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      commitCurrentPopupItem(true);
    }
  });

  // Mengen-Button & X-Button zum Entfernen der Menge
  document.getElementById("btn-open-qty").addEventListener("click", toggleQuantityOverlay);
  document.getElementById("btn-clear-qty").addEventListener("click", (e) => {
    e.stopPropagation();
    state.popup.quantityNumber = "";
    state.popup.quantityUnit = "";
    updatePopupUI();
    keepPopupKeyboardAlive();
  });

  document.getElementById("btn-confirm-qty-no-unit").addEventListener("click", () => {
    confirmQuantitySelection("");
  });

  // Mit Enter im direkten Mengen-Zahlenfeld schließen (standardmäßig keine Einheit)
  document.getElementById("qty-number-input").addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      confirmQuantitySelection("");
    }
  });

  // Klick auf eine Einheit (g, kg, Stk., ml, l, Bund, Keine Einheit)
  document.querySelectorAll(".unit-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      confirmQuantitySelection(btn.dataset.unit || "");
    });
  });

  // Kategorie-Button & schwebende Kategorie-Bubble
  document.getElementById("btn-open-cat").addEventListener("click", toggleCategoryOverlay);

  document.getElementById("tab-cat-list").addEventListener("click", () => {
    state.popup.catTab = "list";
    state.popup.catPage = 0;
    renderCategoryOverlay();
    keepPopupKeyboardAlive();
  });

  document.getElementById("tab-cat-own").addEventListener("click", () => {
    state.popup.catTab = "own";
    state.popup.catPage = 0;
    renderCategoryOverlay();
    keepPopupKeyboardAlive();
  });

  document.getElementById("btn-cat-prev-page").addEventListener("click", () => {
    if (state.popup.catPage > 0) {
      state.popup.catPage--;
      renderCategoryOverlay();
      keepPopupKeyboardAlive();
    }
  });

  document.getElementById("btn-cat-next-page").addEventListener("click", () => {
    state.popup.catPage++;
    renderCategoryOverlay();
    keepPopupKeyboardAlive();
  });

  // Shortcut für neue Kategorie direkt aus der Kategorieauswahl im Pop-up
  document.getElementById("btn-shortcut-new-cat").addEventListener("click", () => {
    openCategoryEditorModal(null, true);
  });

  // Wichtig-Markierung umschalten (Tastatur bleibt offen)
  document.getElementById("btn-toggle-important").addEventListener("click", () => {
    state.popup.important = !state.popup.important;
    updatePopupUI();
    keepPopupKeyboardAlive();
  });

  // Bestehenden Eintrag speichern oder löschen
  document.getElementById("btn-save-edited-item").addEventListener("click", () => {
    commitCurrentPopupItem(false);
  });

  document.getElementById("btn-delete-current-item").addEventListener("click", async () => {
    if (state.popup.editingItemId) {
      await deleteItem(state.popup.editingItemId);
      state.popup.editingItemId = null;
      closeItemPopup();
    }
  });

  // 6. Einstellungen im Drawer: Dark/Light Mode & Eigene Kategorien
  document.getElementById("toggle-darkmode").addEventListener("change", (e) => {
    state.darkMode = e.target.checked;
    localStorage.setItem("einkaufsliste_darkmode", String(state.darkMode));
    applyTheme();
  });

  document.getElementById("btn-add-own-category").addEventListener("click", () => {
    openCategoryEditorModal(null, false);
  });

  document.getElementById("btn-close-cat-modal").addEventListener("click", () => {
    document.getElementById("modal-category-editor").classList.add("hidden");
    keepPopupKeyboardAlive();
  });

  document.getElementById("form-category-editor").addEventListener("submit", handleSaveCategoryForm);
  document.getElementById("btn-delete-category").addEventListener("click", handleDeleteCategory);

  document.querySelectorAll(".color-swatch").forEach((swatch) => {
    swatch.addEventListener("click", () => {
      document.getElementById("input-cat-color").value = swatch.dataset.color;
    });
  });

  // 7. Neue Liste starten / Liste mit 6-stelligem Code beitreten
  const listModal = document.getElementById("modal-list-action");
  const tabStart = document.getElementById("tab-start-list");
  const tabJoin = document.getElementById("tab-join-list");
  const formCreate = document.getElementById("form-create-list");
  const formJoin = document.getElementById("form-join-list");

  document.getElementById("btn-new-list-modal").addEventListener("click", () => {
    closeDrawer();
    listModal.classList.remove("hidden");
    document.getElementById("input-new-list-name").focus();
  });

  document.getElementById("btn-close-list-modal").addEventListener("click", () => {
    listModal.classList.add("hidden");
  });

  tabStart.addEventListener("click", () => {
    tabStart.classList.add("active");
    tabJoin.classList.remove("active");
    formCreate.classList.remove("hidden");
    formJoin.classList.add("hidden");
    document.getElementById("input-new-list-name").focus();
  });

  tabJoin.addEventListener("click", () => {
    tabJoin.classList.add("active");
    tabStart.classList.remove("active");
    formJoin.classList.remove("hidden");
    formCreate.classList.add("hidden");
    document.getElementById("input-join-code").focus();
  });

  formCreate.addEventListener("submit", async (e) => {
    e.preventDefault();
    const input = document.getElementById("input-new-list-name");
    await createNewList(input.value);
    input.value = "";
    listModal.classList.add("hidden");
  });

  formJoin.addEventListener("submit", async (e) => {
    e.preventDefault();
    const input = document.getElementById("input-join-code");
    const ok = await joinListByCode(input.value);
    if (ok) {
      input.value = "";
      listModal.classList.add("hidden");
    }
  });

  // 8. Liste freigeben (6-stelliger Code)
  const shareModal = document.getElementById("modal-share-list");
  document.getElementById("btn-share-list").addEventListener("click", async () => {
    const list = getActiveList();
    if (!list) return;
    if (!list.shareCode) {
      list.shareCode = generateSixDigitCode();
      await persistList(list);
    }
    document.getElementById("share-list-name").textContent = list.name;
    document.getElementById("share-code-box").textContent = list.shareCode;
    shareModal.classList.remove("hidden");
  });

  document.getElementById("btn-close-share-modal").addEventListener("click", () => {
    shareModal.classList.add("hidden");
  });

  document.getElementById("btn-copy-share-code").addEventListener("click", async () => {
    const list = getActiveList();
    if (!list || !list.shareCode) return;
    try {
      await navigator.clipboard.writeText(list.shareCode);
      showToast(`Code ${list.shareCode} in die Zwischenablage kopiert!`);
    } catch {
      showToast(`Freigabecode: ${list.shareCode}`);
    }
  });

  document.getElementById("btn-regenerate-share-code").addEventListener("click", async () => {
    const list = getActiveList();
    if (!list) return;
    list.shareCode = generateSixDigitCode();
    document.getElementById("share-code-box").textContent = list.shareCode;
    await persistList(list);
    showToast("Neuer 6-stelliger Code generiert");
  });
}

// ============================================================================
// 14. APP-START
// ============================================================================
document.addEventListener("DOMContentLoaded", () => {
  applyTheme();
  setupVisualViewportAdapter();
  bindEvents();
  initBackend();
});
