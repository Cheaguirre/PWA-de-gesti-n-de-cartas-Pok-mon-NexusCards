// ==================== VARIABLES GLOBALES ====================
let db;
let catalogo = [];
let currentRole = null;   // 'coleccionista' | 'admin'
let currentUser = null;   // username cuando es coleccionista

const filterState = {
  term: "",      // texto de búsqueda
  sort: "id",    // id | name-asc | name-desc | rarity
  rarity: "all"  // all | comun | rara | ultra
};

initAuth
// ==================== HELPERS: BASE64 / SAL / HASH ====================
function bytesToBase64(bytes) {
  let binary = "";
  bytes.forEach(b => binary += String.fromCharCode(b));
  return btoa(binary);
}

function base64ToBytes(base64) {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

function generateSalt(length = 16) {
  const salt = new Uint8Array(length);
  crypto.getRandomValues(salt);
  return bytesToBase64(salt);
}

// PBKDF2 para contraseña y respuesta de seguridad
async function hashSecretPBKDF2(secret, saltBase64) {
  const enc = new TextEncoder();
  const salt = base64ToBytes(saltBase64);

  const keyMaterial = await crypto.subtle.importKey(
    "raw",
    enc.encode(secret),
    "PBKDF2",
    false,
    ["deriveBits"]
  );

  const bits = await crypto.subtle.deriveBits(
    {
      name: "PBKDF2",
      salt,
      iterations: 100000,
      hash: "SHA-256"
    },
    keyMaterial,
    256
  );

  return bytesToBase64(new Uint8Array(bits));
}


// ==================== INDEXEDDB ====================
function openDB() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open("nexuscards-db", 2);

    request.onupgradeneeded = function (event) {
      db = event.target.result;

      // Usuarios (username como clave)
      if (!db.objectStoreNames.contains("usuarios")) {
        db.createObjectStore("usuarios", { keyPath: "username" });
      }

      // Nueva versión de coleccion: por usuario + carta
      if (!db.objectStoreNames.contains("coleccion_v2")) {
        const cstore = db.createObjectStore("coleccion_v2", { keyPath: "key" });
        cstore.createIndex("byUser", "username", { unique: false });
        cstore.createIndex("byUserCarta", ["username", "idCarta"], { unique: true });
      }

      // Nueva versión de wishlist: por usuario + carta
      if (!db.objectStoreNames.contains("wishlist_v2")) {
        const wstore = db.createObjectStore("wishlist_v2", { keyPath: "key" });
        wstore.createIndex("byUser", "username", { unique: false });
        wstore.createIndex("byUserCarta", ["username", "idCarta"], { unique: true });
      }
    };

    request.onsuccess = function (event) {
      db = event.target.result;
      resolve(db);
    };

    request.onerror = function () {
      console.error("Error al abrir IndexedDB", request.error);
      reject(request.error);
    };
  });
}

function txStore(name, mode = "readonly") {
  const tx = db.transaction(name, mode);
  return tx.objectStore(name);
}


// ===== Usuarios =====
function getUser(username) {
  return new Promise((resolve, reject) => {
    const store = txStore("usuarios");
    const req = store.get(username);
    req.onsuccess = () => resolve(req.result || null);
    req.onerror = () => reject(req.error);
  });
}

function saveUser(user) {
  return new Promise((resolve, reject) => {
    const store = txStore("usuarios", "readwrite");
    const req = store.put(user);
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
  });
}

/// REVISAR PORTQUE NO ME APARECE QUE SE USE ESTO CUANDO CREAMOS AL COLECCIONISTA///

async function registerUser({ username, password, question, answer }) {
  // Normalizamos username y respuesta
  username = username.trim().toLowerCase();
  const normalizedAnswer = answer.trim().toLowerCase();

  // Verificar si ya existe
  const existing = await getUser(username);
  if (existing) {
    throw new Error("El usuario ya existe.");
  }

  // ===== HASH CONTRASEÑA =====
  // generateSalt() ya devuelve la sal en Base64 (lo que espera hashSecretPBKDF2)
  const passSalt = generateSalt();
  const passHash = await hashSecretPBKDF2(password, passSalt);

  // ===== HASH RESPUESTA (respuesta normalizada) =====
  const answerSalt = generateSalt();
  const answerHash = await hashSecretPBKDF2(normalizedAnswer, answerSalt);

  const newUser = {
    username,
    passSalt,    // Base64
    passHash,    // Base64
    question,    // código de la pregunta
    answerSalt,  // Base64
    answerHash,  // Base64
    createdAt: Date.now()
  };

  await saveUser(newUser);
}




async function verifyPassword(user, password) {
  const hash = await hashSecretPBKDF2(password, user.passSalt);
  return hash === user.passHash;
}

async function verifyAnswer(user, answer) {
  const normalized = answer.trim().toLowerCase();
  const hash = await hashSecretPBKDF2(normalized, user.answerSalt);
  return hash === user.answerHash;
}



// ===== Colección y Wishlist por usuario =====
function setColeccionCount(idCarta, count) {
  return new Promise((resolve, reject) => {
    if (!currentUser) {
      console.warn("No hay usuario logueado");
      resolve();
      return;
    }

    const store = txStore("coleccion_v2", "readwrite");
    const key = `${currentUser}#${idCarta}`;

    if (count <= 0) {
      const delReq = store.delete(key);
      delReq.onsuccess = () => resolve();
      delReq.onerror = () => reject(delReq.error);
      return;
    }

    const req = store.put({
      key,
      username: currentUser,
      idCarta,
      count,
      fechaAgregado: Date.now()
    });

    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
  });
}

function getColeccion() {
  return new Promise((resolve, reject) => {
    if (!currentUser) {
      resolve([]);
      return;
    }
    const store = txStore("coleccion_v2");
    const index = store.index("byUser");
    const req = index.getAll(currentUser);
    req.onsuccess = () => resolve(req.result || []);
    req.onerror = () => reject(req.error);
  });
}

function getWishlistForCurrentUser() {
  return new Promise((resolve, reject) => {
    if (!currentUser) {
      resolve([]);
      return;
    }

    const store = txStore("wishlist_v2");
    const index = store.index("byUser");
    const req = index.getAll(currentUser);

    req.onsuccess = () => resolve(req.result || []);
    req.onerror = () => reject(req.error);
  });
}



function toggleWishlist(idCarta) {
  return new Promise((resolve, reject) => {
    if (!currentUser) {
      console.warn("No hay usuario logueado");
      resolve(false);
      return;
    }

    const store = txStore("wishlist_v2", "readwrite");
    const key = `${currentUser}#${idCarta}`;
    const getReq = store.get(key);

    getReq.onsuccess = () => {
      if (getReq.result) {
        const delReq = store.delete(key);
        delReq.onsuccess = () => resolve(false);
        delReq.onerror = () => reject(delReq.error);
      } else {
        const putReq = store.put({
          key,
          username: currentUser,
          idCarta,
          fechaAgregado: Date.now()
        });
        putReq.onsuccess = () => resolve(true);
        putReq.onerror = () => reject(putReq.error);
      }
    };

    getReq.onerror = () => reject(getReq.error);
  });
}

function isInWishlist(idCarta) {
  return new Promise((resolve, reject) => {
    if (!currentUser) {
      resolve(false);
      return;
    }

    const store = txStore("wishlist_v2");
    const key = `${currentUser}#${idCarta}`;
    const req = store.get(key);

    req.onsuccess = () => {
      resolve(!!req.result);
    };
    req.onerror = () => reject(req.error);
  });
}

// ==================== SESIÓN Y ROLES ====================
function createSession(username, role) {
  currentRole = role;
  currentUser = role === "coleccionista" ? username : null;

  const token = crypto.randomUUID ? crypto.randomUUID()
    : Math.random().toString(36).slice(2);

  localStorage.setItem(
    "nexuscards-session",
    JSON.stringify({ username, role, token })
  );

  updateRoleUI();
}

function loadSession() {
  const raw = localStorage.getItem("nexuscards-session");
  if (!raw) return null;
  try {
    const data = JSON.parse(raw);
    currentRole = data.role;
    currentUser = data.role === "coleccionista" ? data.username : null;
    updateRoleUI();
    return data;
  } catch {
    return null;
  }
}

function clearSession() {
  localStorage.removeItem("nexuscards-session");
  currentRole = null;
  currentUser = null;
  updateRoleUI();
}


function updateRoleUI() {
  const roleLabel = document.getElementById("role-label");
  const adminTabBtn = document.getElementById("admin-tab-btn");

  if (roleLabel) {
    if (!currentRole) {
      roleLabel.textContent = "Rol: -";
    } else if (currentRole === "admin") {
      roleLabel.textContent = "Rol: Administrador";
    } else {
      roleLabel.textContent = `Rol: Coleccionista (${currentUser})`;
    }
  }

  if (adminTabBtn) {
    adminTabBtn.classList.toggle("hidden", currentRole !== "admin");
  }
}

function showApp() {
  document.getElementById("auth-shell").classList.add("hidden");
  document.getElementById("app-shell").classList.remove("hidden");
}

function showAuth() {
  document.getElementById("auth-shell").classList.remove("hidden");
  document.getElementById("app-shell").classList.add("hidden");
}

function attachLogout() {
  const btn = document.getElementById("logout-btn");
  if (!btn || btn.dataset.bound) return; // evitar duplicar eventos

  btn.dataset.bound = "1";
  btn.addEventListener("click", () => {
    const sure = confirm("¿Seguro que quieres cerrar sesión?");
    if (!sure) return;

    clearSession();
    showAuth();
  });
}

function attachPasswordToggles() {
  document.querySelectorAll(".toggle-pass").forEach(btn => {
    btn.addEventListener("click", () => {
      const id = btn.dataset.target;
      const input = document.getElementById(id);
      if (input.type === "password") {
        input.type = "text";
        btn.textContent = "🙈"; // icono cuando se muestra
      } else {
        input.type = "password";
        btn.textContent = "👁"; // icono cuando está oculto
      }
    });
  });
}


function validatePassword(pass) {
  const errors = [];

  if (pass.length < 8) {
    errors.push("Debe tener al menos 8 caracteres");
  }

  if (!/[A-Z]/.test(pass)) {
    errors.push("Debe incluir una letra mayúscula");
  }

  if (!/\./.test(pass)) {
    errors.push("Debe incluir un punto (.)");
  }

  return errors;
}


// ==================== AUTENTICACIÓN (LOGIN / REGISTRO / ADMIN) ====================
function initAuth() {
  // Tabs
  const tabs = document.querySelectorAll(".auth-tab");
  const views = document.querySelectorAll(".auth-view");

  tabs.forEach(tab => {
    tab.addEventListener("click", () => {
      const target = tab.dataset.auth;
      tabs.forEach(t => t.classList.toggle("active", t === tab));
      views.forEach(v => {
        const prefix =
          target === "login" ? "login" :
          target === "register" ? "register" :
          "admin";
        v.classList.toggle("active", v.id.startsWith(prefix));
      });
    });
  });

  // Si ya hay sesión, pasar directo a la app
  const session = loadSession();
  if (session) {
    showApp();
    initApp();
    
    return;
  }

  // ----- Registro -----------------------------------------------------------------------------------------------------------------
const regForm = document.getElementById("register-form");
regForm.addEventListener("submit", async (e) => {
  e.preventDefault();

  // Normalizamos valores
  const username = document.getElementById("reg-username").value.trim().toLowerCase();
  const pass1 = document.getElementById("reg-password").value;
  const pass2 = document.getElementById("reg-password2").value;
  const question = document.getElementById("reg-question").value;
  let answer = document.getElementById("reg-answer").value.trim();

  if (!username || !pass1 || !answer) {
    alert("Completa todos los campos.");
    return;
  }
  // Validación de contraseña segura
  const passwordErrors = validatePassword(pass1);
  const errorBox = document.getElementById("password-error");

  if (passwordErrors.length > 0) {
    errorBox.textContent = "⚠ " + passwordErrors.join(", ");
    errorBox.classList.remove("hidden");
    errorBox.style.opacity = "1";
    return; // ❌ No permitir continuar
  } else {
    errorBox.classList.add("hidden");
  }

  if (!question) {
    alert("Selecciona una pregunta de seguridad.");
    return;
  }

  if (pass1 !== pass2) {
    alert("Las contraseñas no coinciden.");
    return;
  }

  // 🔥 Convertimos la respuesta a minúsculas
  const normalizedAnswer = answer.toLowerCase();

try {
  await registerUser({
    username,
    password: pass1,
    question,
    answer: normalizedAnswer
  });

  const msg = document.getElementById("register-message");

  // Mostrar mensaje
  msg.textContent = "✔ Tu cuenta ha sido registrada correctamente. Inicie sesión.";
  msg.classList.remove("hidden");
  msg.style.opacity = "1";

  // Espera 2 segundos para mostrar mensaje
  setTimeout(() => {
    msg.style.opacity = "0";
    setTimeout(() => msg.classList.add("hidden"), 500);

    // Luego cambiar a login
    document.querySelector('.auth-tab[data-auth="login"]').click();
    document.getElementById("login-username").value = username;
  }, 2000);

} catch (err) {
  alert("Error al registrar: " + err.message);
}

});



  // ----- Login coleccionista -----
  const loginForm = document.getElementById("login-form");
  loginForm.addEventListener("submit", async (e) => {
    e.preventDefault();
    const username = document.getElementById("login-username").value.trim().toLowerCase();
    const password = document.getElementById("login-password").value;

    try {
      const user = await getUser(username);
      if (!user) {
        alert("Credenciales Incorrecta."); // Mensaje genérico por seguridad podemos poner "Credenciales Incorrectas."
        return;
      }
      const ok = await verifyPassword(user, password);
      if (!ok) {
        alert("Contraseña incorrecta.");
        return;
      }

      createSession(username, "coleccionista");
      showApp();
      initApp();
    } catch (err) {
      alert("Error al iniciar sesión: " + err.message);
    }
  });

  // ----- Recuperar contraseña con pregunta de seguridad -----
  const forgotBtn = document.getElementById("forgot-btn");
  forgotBtn.addEventListener("click", async () => {
    const username = prompt("Ingresa tu nombre de usuario:");
    if (!username) return;

    const user = await getUser(username.trim().toLowerCase());
    if (!user) {
      alert("Usuario no encontrado.");
      return;
    }

    const answer = prompt(user.question);
    if (!answer) return;

    const ok = await verifyAnswer(user, answer);
    if (!ok) {
      alert("Respuesta incorrecta.");
      return;
    }

    const newPass = prompt("Respuesta correcta. Ingresa nueva contraseña:");
    if (!newPass) return;

    const passSalt = generateSalt();
    const passHash = await hashSecretPBKDF2(newPass, passSalt);
    user.passSalt = passSalt;
    user.passHash = passHash;
    await saveUser(user);
    alert("Contraseña actualizada. Ahora puedes iniciar sesión.");
  });

  // ----- Login administrador (credenciales fijas de ejemplo) -----
  const adminForm = document.getElementById("admin-form");
  adminForm.addEventListener("submit", (e) => {
    e.preventDefault();
    const user = document.getElementById("admin-user").value;
    const pass = document.getElementById("admin-pass").value;

    if (user === "admin" && pass === "admin123") {
      createSession("admin", "admin");
      showApp();
      initApp();
    } else {
      alert("Credenciales de administrador incorrectas.");

    }
  });
  attachPasswordToggles();

}


// ==================== CARGA DE CATÁLOGO DESDE POKEAPI ====================
async function loadCatalogo() {
  // Si ya lo tenemos en memoria, solo aplica filtros y sale
  if (catalogo.length > 0) {
    applyFiltersAndRender();
    return;
  }

  try {
    console.log("Cargando Pokémon desde la API...");
    const res = await fetch("https://pokeapi.co/api/v2/pokemon?limit=50&offset=0");
    const data = await res.json();

    const promises = data.results.map(async (p) => {
      const detalleRes = await fetch(p.url);
      const pokemon = await detalleRes.json();
      return mapPokemonToCarta(pokemon);
    });

    catalogo = await Promise.all(promises);
    console.log("Catálogo cargado:", catalogo);

    // AQUÍ: en vez de renderCatalogo(catalogo);
    applyFiltersAndRender();
  } catch (err) {
    console.error("Error cargando catálogo:", err);
  }
}


function mapPokemonToCarta(pokemon) {
  const tipos = pokemon.types.map(t => t.type.name).join(", ");
  const ataqueBase = pokemon.stats.find(s => s.stat.name === "attack")?.base_stat ?? 50;

  let raridad = "Común";
  if (ataqueBase >= 90) raridad = "Ultra-Rara";
  else if (ataqueBase >= 70) raridad = "Rara";

  const imagen = pokemon.sprites?.other?.["official-artwork"]?.front_default
    || pokemon.sprites?.front_default
    || "";

  return {
    id: pokemon.id,
    nombre: pokemon.name,
    tipo: tipos,
    raridad,
    imagenURL: imagen,
    texto: `Pokémon de tipo ${tipos} con ataque base ${ataqueBase}.`
  };
}


// ==================== RENDER DE VISTAS ====================
function renderCatalogo(lista) {
  const grid = document.getElementById("catalog-grid");
  if (!grid) return;

  grid.innerHTML = "";

  lista.forEach(c => {
    const card = document.createElement("article");
    card.className = "card";
    card.dataset.id = c.id;

    const img = document.createElement("img");
    img.src = c.imagenURL;
    img.alt = c.nombre;

    const name = document.createElement("h3");
    name.textContent = c.nombre;

    const type = document.createElement("p");
    type.textContent = c.tipo;

    const rarity = document.createElement("p");
    rarity.textContent = c.raridad;

    card.appendChild(img);
    card.appendChild(name);
    card.appendChild(type);
    card.appendChild(rarity);

    card.addEventListener("click", () => openCardDetail(c.id));

    grid.appendChild(card);
  });
}


// ===== Detalle de carta =====
async function openCardDetail(id) {
  const carta = catalogo.find(c => c.id === id);
  if (!carta) return;

  const modal = document.getElementById("card-modal");
  document.getElementById("detail-img").src = carta.imagenURL;
  document.getElementById("detail-name").textContent = carta.nombre;
  document.getElementById("detail-type").textContent = carta.tipo;
  document.getElementById("detail-text").textContent = carta.texto || "";

  modal.dataset.idCarta = id;

  // ===== Colección: cuántas copias tiene =====
  const coleccion = await getColeccion();
  const item = coleccion.find(x => x.idCarta === id);
  const count = item ? item.count : 0;
  document.getElementById("card-count").textContent = count.toString();

  // ===== Wishlist: configurar texto del botón SOLO para esta carta =====
  const wishlistBtn = document.getElementById("toggle-wishlist");

  if (!currentUser) {
    // si no hay usuario logueado, deshabilitamos el botón
    wishlistBtn.disabled = true;
    wishlistBtn.textContent = "Inicia sesión para usar Wishlist";
  } else {
    wishlistBtn.disabled = false;
    const inWish = await isInWishlist(id);
    wishlistBtn.textContent = inWish ? "Quitar de Wishlist" : "Añadir a Wishlist";
  }

  modal.classList.remove("hidden");
}


function attachDetailEvents() {
  const closeBtn = document.getElementById("close-modal");
  const modal = document.getElementById("card-modal");

  closeBtn.addEventListener("click", () => {
    modal.classList.add("hidden");
  });

  document.getElementById("inc-count").addEventListener("click", () => {
    updateCount(1);
  });

  document.getElementById("dec-count").addEventListener("click", () => {
    updateCount(-1);
  });

  document.getElementById("toggle-wishlist").addEventListener("click", async () => {
    const idCarta = parseInt(document.getElementById("card-modal").dataset.idCarta, 10);
    const added = await toggleWishlist(idCarta);
    document.getElementById("toggle-wishlist").textContent =
      added ? "Quitar de Wishlist" : "Añadir a Wishlist";

    await renderWishlistView();
  });
}

async function updateCount(delta) {
  const modal = document.getElementById("card-modal");
  const idCarta = parseInt(modal.dataset.idCarta, 10);
  const span = document.getElementById("card-count");
  let current = parseInt(span.textContent, 10) || 0;

  current = Math.max(0, current + delta);
  span.textContent = current.toString();

  await setColeccionCount(idCarta, current);
  await renderColeccionView();
}


// ===== Colección =====
async function renderColeccionView() {
  const grid = document.getElementById("coleccion-grid");
  grid.innerHTML = "";

  const coleccion = await getColeccion();
  const byId = new Map(catalogo.map(c => [c.id, c]));

  coleccion.forEach(item => {
    if (item.count <= 0) return;
    const carta = byId.get(item.idCarta);
    if (!carta) return;

    const card = document.createElement("article");
    card.className = "card";
    card.dataset.id = carta.id;

    const img = document.createElement("img");
    img.src = carta.imagenURL;
    img.alt = carta.nombre;

    const name = document.createElement("h3");
    name.textContent = carta.nombre;

    const countP = document.createElement("p");
    countP.textContent = `Copias: ${item.count}`;

    card.appendChild(img);
    card.appendChild(name);
    card.appendChild(countP);

    card.addEventListener("click", () => openCardDetail(carta.id));

    grid.appendChild(card);
  });
}


// ===== Wishlist =====
async function renderWishlistView() {
  const grid = document.getElementById("wishlist-grid");
  grid.innerHTML = "";

  if (!currentUser) {
    document.getElementById("wishlist-count").textContent = "Debes iniciar sesión.";
    return;
  }

  const store = txStore("wishlist_v2");
  const index = store.index("byUser");
  const req = index.getAll(currentUser);

  req.onsuccess = () => {
    const wishlist = req.result || [];
    document.getElementById("wishlist-count").textContent =
      `${wishlist.length} cartas deseadas`;

    const byId = new Map(catalogo.map(c => [c.id, c]));
    wishlist.forEach(item => {
      const carta = byId.get(item.idCarta);
      if (!carta) return;

      const card = document.createElement("article");
      card.className = "card";
      card.dataset.id = carta.id;

      const img = document.createElement("img");
      img.src = carta.imagenURL;
      img.alt = carta.nombre;

      const name = document.createElement("h3");
      name.textContent = carta.nombre;

      card.appendChild(img);
      card.appendChild(name);

      card.addEventListener("click", () => openCardDetail(carta.id));

      grid.appendChild(card);
    });
  };
}


// ==================== BÚSQUEDA Y NAVEGACIÓN ====================
function normalize(str) {
  return (str || "").toString().trim().toLowerCase();
}

function attachSearch() {
  const searchInput = document.getElementById("search-input");
  const sortSelect = document.getElementById("sort-select");
  const raritySelect = document.getElementById("rarity-select");

  if (!searchInput || !sortSelect || !raritySelect) {
    console.warn("No se encontraron controles de búsqueda/filtro");
    return;
  }

  // Buscar por texto
  searchInput.addEventListener("input", () => {
    filterState.term = normalize(searchInput.value);
    applyFiltersAndRender();
  });

  // Orden
  sortSelect.addEventListener("change", () => {
    filterState.sort = sortSelect.value;
    applyFiltersAndRender();
  });

  // Rareza
  raritySelect.addEventListener("change", () => {
    filterState.rarity = raritySelect.value;
    applyFiltersAndRender();
  });
}

function applyFiltersAndRender() {
  // Si todavía no tenemos catálogo, no hacemos nada
  if (!catalogo || catalogo.length === 0) {
    return;
  }

  // Copia del catálogo original
  let lista = catalogo.slice();

  // 1) Filtro de texto (nombre o tipo)
  if (filterState.term) {
    lista = lista.filter(c =>
      normalize(c.nombre).includes(filterState.term) ||
      normalize(c.tipo).includes(filterState.term)
    );
  }

  // 2) Filtro por rareza
  if (filterState.rarity !== "all") {
    lista = lista.filter(c => {
      const r = normalize(c.raridad); // ej: "común", "rara", "ultra-rara"
      if (filterState.rarity === "comun") {
        return r === "común" || r === "comun";
      }
      if (filterState.rarity === "rara") {
        return r === "rara";
      }
      if (filterState.rarity === "ultra") {
        return r.includes("ultra");
      }
      return true;
    });
  }

  // 3) Orden
  switch (filterState.sort) {
    case "name-asc":
      lista.sort((a, b) =>
        normalize(a.nombre).localeCompare(normalize(b.nombre))
      );
      break;
    case "name-desc":
      lista.sort((a, b) =>
        normalize(b.nombre).localeCompare(normalize(a.nombre))
      );
      break;
    case "rarity": {
      const order = {
        "ultra-rara": 0,
        "ultra rara": 0,
        "rara": 1,
        "común": 2,
        "comun": 2
      };
      lista.sort((a, b) => {
        const ra = order[normalize(a.raridad)] ?? 99;
        const rb = order[normalize(b.raridad)] ?? 99;
        if (ra !== rb) return ra - rb;
        return normalize(a.nombre).localeCompare(normalize(b.nombre));
      });
      break;
    }
    case "id":
    default:
      lista.sort((a, b) => a.id - b.id);
      break;
  }

  // 4) Pintar en pantalla
  renderCatalogo(lista);
}


function applyFiltersAndRender() {
  // Copia del catálogo original
  let lista = catalogo.slice();

  // 1) Filtro de texto (nombre o tipo)
  if (filterState.term) {
    lista = lista.filter(c =>
      normalize(c.nombre).includes(filterState.term) ||
      normalize(c.tipo).includes(filterState.term)
    );
  }

  // 2) Filtro por rareza
  if (filterState.rarity !== "all") {
    lista = lista.filter(c => {
      const r = normalize(c.raridad); // ej: "común", "rara", "ultra-rara"
      if (filterState.rarity === "comun") {
        return r === "común" || r === "comun";
      }
      if (filterState.rarity === "rara") {
        return r === "rara";
      }
      if (filterState.rarity === "ultra") {
        return r.includes("ultra");
      }
      return true;
    });
  }

  // 3) Orden
  switch (filterState.sort) {
    case "name-asc":
      lista.sort((a, b) =>
        normalize(a.nombre).localeCompare(normalize(b.nombre))
      );
      break;
    case "name-desc":
      lista.sort((a, b) =>
        normalize(b.nombre).localeCompare(normalize(a.nombre))
      );
      break;
    case "rarity": {
      const order = {
        "ultra-rara": 0,
        "ultra rara": 0,
        "rara": 1,
        "común": 2,
        "comun": 2
      };
      lista.sort((a, b) => {
        const ra = order[normalize(a.raridad)] ?? 99;
        const rb = order[normalize(b.raridad)] ?? 99;
        if (ra !== rb) return ra - rb;
        // si tienen misma rareza, ordenamos por nombre
        return normalize(a.nombre).localeCompare(normalize(b.nombre));
      });
      break;
    }
    case "id":
    default:
      lista.sort((a, b) => a.id - b.id);
      break;
  }

  // 4) Pintar en pantalla
  renderCatalogo(lista);
}

async function exportUserData() {
  if (!currentUser) {
    alert("Debes iniciar sesión como coleccionista para exportar tus datos.");
    return;
  }

  try {
    const user = await getUser(currentUser);
    if (!user) {
      alert("No se encontró el usuario en la base de datos local.");
      return;
    }

    const coleccion = await getColeccion();              // ya existe
    const wishlist = await getWishlistForCurrentUser();  // nueva función

    const payload = {
      version: 1,
      exportedAt: new Date().toISOString(),
      user,
      coleccion,
      wishlist
    };

    const blob = new Blob([JSON.stringify(payload, null, 2)], {
      type: "application/json"
    });

    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `nexuscards-${currentUser}.json`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);

    alert("Datos exportados. Guarda el archivo JSON y llévalo al otro dispositivo.");
  } catch (err) {
    console.error(err);
    alert("Error al exportar datos: " + err.message);
  }
}


async function importUserDataFromFile(file) {
  if (!file) return;

  try {
    const text = await file.text();
    const data = JSON.parse(text);

    if (!data.user || !data.user.username) {
      alert("Archivo inválido: no contiene usuario.");
      return;
    }

    const username = data.user.username;

    // Confirmación
    const sure = confirm(
      `Se importarán los datos del usuario "${username}". ` +
      `Esto puede sobreescribir datos locales. ¿Continuar?`
    );
    if (!sure) return;

    // 1) Guardar/actualizar usuario
    await saveUser(data.user);

    // 2) Cambiar sesión actual a este usuario
    createSession(username, "coleccionista");

    // 3) Importar colección
    if (Array.isArray(data.coleccion)) {
      const storeC = txStore("coleccion_v2", "readwrite");

      // Borramos la coleccion actual de ese usuario
      const existing = await getColeccion();
      for (const item of existing) {
        storeC.delete(item.key);
      }

      // Insertamos la nueva
      for (const item of data.coleccion) {
        // forzamos username correcto y key
        const key = `${username}#${item.idCarta}`;
        storeC.put({
          key,
          username,
          idCarta: item.idCarta,
          count: item.count,
          fechaAgregado: item.fechaAgregado || Date.now()
        });
      }
    }

    // 4) Importar wishlist
    if (Array.isArray(data.wishlist)) {
      const storeW = txStore("wishlist_v2", "readwrite");

      // Borramos wishlist actual del usuario
      const idx = storeW.index("byUser");
      const reqAll = idx.getAll(username);
      await new Promise((resolve, reject) => {
        reqAll.onsuccess = () => {
          const arr = reqAll.result || [];
          arr.forEach(item => storeW.delete(item.key));
          resolve();
        };
        reqAll.onerror = () => reject(reqAll.error);
      });

      // Insertamos nueva wishlist
      for (const item of data.wishlist) {
        const key = `${username}#${item.idCarta}`;
        storeW.put({
          key,
          username,
          idCarta: item.idCarta,
          fechaAgregado: item.fechaAgregado || Date.now()
        });
      }
    }

    alert("Datos importados correctamente. Se ha iniciado sesión con ese usuario.");
    // refrescamos vistas
    await renderColeccionView();
    await renderWishlistView();
  } catch (err) {
    console.error(err);
    alert("Error al importar datos: " + err.message);
  }
}
function attachAccountTransfer() {
  const exportBtn = document.getElementById("btn-export-data");
  const importInput = document.getElementById("file-import-data");

  if (exportBtn && !exportBtn.dataset.bound) {
    exportBtn.dataset.bound = "1";
    exportBtn.addEventListener("click", () => {
      exportUserData();
    });
  }

  if (importInput && !importInput.dataset.bound) {
    importInput.dataset.bound = "1";
    importInput.addEventListener("change", async (e) => {
      const file = e.target.files[0];
      if (!file) return;
      await importUserDataFromFile(file);
      // limpiamos el input para poder volver a elegir el mismo archivo si hace falta
      e.target.value = "";
    });
  }
}

function attachNav() {
  document.querySelectorAll(".bottom-nav button").forEach(btn => {
    btn.addEventListener("click", () => {
      const target = btn.dataset.view;

      document.querySelectorAll(".view").forEach(v =>
        v.classList.toggle("active", v.id === target)
      );

      if (target === "view-coleccion") renderColeccionView();
      if (target === "view-wishlist") renderWishlistView();
      if (target === "view-admin") attachAdminPanel();
    });
  });
}


// ==================== ESTADO ONLINE / OFFLINE ====================
function updateStatus(online) {
  const el = document.getElementById("status-indicator");
  if (!el) return;

  el.textContent = online ? "Online" : "Offline";

  el.classList.remove("online", "offline");
  el.classList.add(online ? "online" : "offline");
}

function initNetworkStatus() {
  updateStatus(navigator.onLine);

  window.addEventListener("online", () => updateStatus(true));
  window.addEventListener("offline", () => updateStatus(false));
}


// ==================== PANEL ADMIN ====================
function attachAdminPanel() {
  if (currentRole !== "admin") return;

  const reloadBtn = document.getElementById("btn-reload-catalog");
  const clearBtn = document.getElementById("btn-clear-storage");
  const swInfo = document.getElementById("sw-info");

  if (reloadBtn && !reloadBtn.dataset.bound) {
    reloadBtn.dataset.bound = "1";
    reloadBtn.addEventListener("click", async () => {
      catalogo = [];
      await loadCatalogo();
      alert("Catálogo recargado desde la API.");
    });
  }

  if (clearBtn && !clearBtn.dataset.bound) {
    clearBtn.dataset.bound = "1";
    clearBtn.addEventListener("click", () => {
      const sure = confirm("Se borrarán todas las colecciones locales y la sesión. ¿Continuar?");
      if (!sure) return;

      indexedDB.deleteDatabase("nexuscards-db");
      clearSession();
      alert("Datos borrados. Recarga la página.");
      location.reload();
    });
  }

  if (swInfo && "serviceWorker" in navigator) {
    navigator.serviceWorker.getRegistration().then(reg => {
      if (!reg) {
        swInfo.textContent = "Service Worker no registrado.";
      } else {
        swInfo.textContent = `Service Worker activo con scope: ${reg.scope}`;
      }
    });
  }
}

///..........................................................
// ----- Login administrador (credenciales fijas) -----
//-----------------------------------------------------------
const adminForm = document.getElementById("admin-form");
adminForm.addEventListener("submit", (e) => {
  e.preventDefault();
  const user = document.getElementById("admin-user").value;
  const pass = document.getElementById("admin-pass").value;
 /// PODEMOS CAMBIAR ESTO PARA ACTUALIZAR EL ADNISTRADOR///
 
  if (user === "admin" && pass === "admin123") {
    createSession("admin", "admin");
    showApp();
    initApp();
  } else {
    alert("Credenciales de administrador incorrectas.");
  }
});


clearSession
// ==================== INICIALIZACIÓN DE LA APP ====================
async function initApp() {
  await loadCatalogo();
  attachDetailEvents();
  attachSearch(); 
  attachNav();
  initNetworkStatus();
  attachAdminPanel();
  attachAccountTransfer();
}


// ==================== SERVICE WORKER + ARRANQUE ====================
if ("serviceWorker" in navigator) {
  navigator.serviceWorker.register("./sw.js")
    .catch(err => console.error("Error registrando SW", err));
}

openDB()
  .then(() => {
    console.log("IndexedDB lista");
    initWelcomeScreen();
    initAuth();
    attachLogout(); 
  })
  .catch(err => console.error("Error iniciando app", err));


// ==================== PANTALLA DE BIENVENIDA ====================
function initWelcomeScreen() {
  const screen = document.getElementById("welcome-screen");
  const startBtn = document.getElementById("start-btn");

  // Si ya hay sesión → saltar bienvenida
  const session = localStorage.getItem("nexuscards-session");
  if (session) {
    screen.classList.add("hidden");
    return;
  }

  startBtn.addEventListener("click", () => {
    screen.classList.add("hidden");
  });
}

