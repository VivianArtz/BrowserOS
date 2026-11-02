// Shared local settings. Original media files are stored as blobs to preserve animation/audio.
const settingsDatabase = new Promise((resolve, reject) => {
    const request = indexedDB.open("BrowserOS", 1);
    request.onupgradeneeded = () => {
        request.result.createObjectStore("settings");
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
});

async function storedSetting(action, key, value) {
    const database = await settingsDatabase;
    return new Promise((resolve, reject) => {
        const transaction = database.transaction(
            "settings",
            action === "get" ? "readonly" : "readwrite"
        );
        const settings = transaction.objectStore("settings");
        const request =
            action === "get"
                ? settings.get(key)
                : action === "delete"
                  ? settings.delete(key)
                  : settings.put(value, key);
        transaction.oncomplete = () => resolve(request.result);
        transaction.onabort = () => reject(transaction.error);
        transaction.onerror = () => reject(transaction.error);
    });
}

// Clock
const timeElement = document.getElementById("time");
const dateElement = document.getElementById("date");

function updateClock() {
    const now = new Date();

    timeElement.textContent = now.toLocaleTimeString([], {
        hour: "2-digit",
        minute: "2-digit"
    });

    dateElement.textContent = now.toLocaleDateString([], {
        weekday: "short",
        month: "short",
        day: "numeric"
    });
    updateDesktopClock(now);
}

// App icons and tile colors
const remoteIconColorCache = new Map();
let iconTilePreferences = Object.create(null);
let tilePreferenceBusy = false;

function tileBackgroundColor(sampledColor, mode) {
    if (mode === "default") return "var(--ui-icon)";
    const compact = (sampledColor || "").replace(/\s/g, "");
    if (mode === "reverse") {
        if (compact === "rgb(0,0,0)") return "rgb(255, 255, 255)";
        if (compact === "rgb(255,255,255)") return "rgb(0, 0, 0)";
    }
    return sampledColor || "var(--ui-icon)";
}

function applyTilePreference(container, sampledColor) {
    if (sampledColor) container.dataset.sampledColor = sampledColor;
    const id = container.closest(".app")?.dataset.appId;
    const mode = id ? iconTilePreferences[id] : "auto";
    container.style.setProperty(
        "--app-icon-color",
        tileBackgroundColor(container.dataset.sampledColor, mode)
    );
}

// Detect the outside of the visible artwork, including transparent padding.
function iconEdgeBackground(pixels, width, height) {
    if (!width || !height) return null;
    let edges = 0,
        white = 0,
        black = 0;
    const visible = (x, y) =>
        x >= 0 && x < width && y >= 0 && y < height && pixels[(y * width + x) * 4 + 3] >= 128;
    for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
            if (!visible(x, y)) continue;
            if (visible(x - 1, y) && visible(x + 1, y) && visible(x, y - 1) && visible(x, y + 1))
                continue;
            const index = (y * width + x) * 4;
            const r = pixels[index],
                g = pixels[index + 1],
                b = pixels[index + 2];
            edges++;
            if (Math.min(r, g, b) >= 210 && Math.max(r, g, b) - Math.min(r, g, b) <= 40) white++;
            if (Math.max(r, g, b) <= 50) black++;
        }
    }
    if (!edges) return null;
    if (white / edges >= 0.6) return "rgb(0, 0, 0)";
    if (black / edges >= 0.6) return "rgb(255, 255, 255)";
    return null;
}

// Match colored artwork, but contrast white or black outer edges.
function iconBackgroundColor(pixels, width, height) {
    const contrast = iconEdgeBackground(pixels, width, height);
    if (contrast) return contrast;
    const counts = new Map();
    let winner = null;
    let highestCount = 0;
    for (let index = 0; index < pixels.length; index += 4) {
        if (pixels[index + 3] < 128) continue;
        const key = (pixels[index] << 16) | (pixels[index + 1] << 8) | pixels[index + 2];
        const count = (counts.get(key) || 0) + 1;
        counts.set(key, count);
        if (count > highestCount) {
            highestCount = count;
            winner = key;
        }
    }
    if (winner === null) return null;
    return `rgb(${(winner >> 16) & 255}, ${(winner >> 8) & 255}, ${winner & 255})`;
}

function readIconColor(image) {
    const canvas = document.createElement("canvas");
    canvas.width = image.naturalWidth || image.width;
    canvas.height = image.naturalHeight || image.height;
    if (!canvas.width || !canvas.height) throw new Error("Icon has no decoded pixels.");
    const context = canvas.getContext("2d", { willReadFrequently: true });
    if (!context) throw new Error("Canvas is unavailable.");
    context.drawImage(image, 0, 0);
    const color = iconBackgroundColor(
        context.getImageData(0, 0, canvas.width, canvas.height).data,
        canvas.width,
        canvas.height
    );
    if (!color) throw new Error("Icon contains no visible pixels.");
    return color;
}

async function permittedRemoteIconColor(address) {
    if (!globalThis.chrome?.permissions || !address)
        throw new Error("Open BrowserOS as an extension to enable icon colors.");
    const url = new URL(address);
    if (!["https:", "http:"].includes(url.protocol)) throw new Error("Unsupported icon address.");
    const origins = [`${url.origin}/*`];
    if (!(await chrome.permissions.contains({ origins })))
        throw new Error("Right-click the app and choose Enable icon color to allow this website.");
    if (!remoteIconColorCache.has(url.href)) {
        const task = (async () => {
            const response = await fetch(url.href, {
                credentials: "omit",
                referrerPolicy: "no-referrer",
                redirect: "error",
                signal: AbortSignal.timeout(10000)
            });
            if (!response.ok) throw new Error(`Icon request failed (${response.status}).`);
            const blob = await response.blob();
            if (blob.size > 5 * 1024 * 1024) throw new Error("The icon file is too large.");
            const localUrl = URL.createObjectURL(blob);
            try {
                const image = new Image();
                await new Promise((resolve, reject) => {
                    image.onload = resolve;
                    image.onerror = () => reject(new Error("Icon file could not be decoded."));
                    image.src = localUrl;
                });
                return readIconColor(image);
            } finally {
                URL.revokeObjectURL(localUrl);
            }
        })();
        remoteIconColorCache.set(url.href, task);
        task.catch(() => remoteIconColorCache.delete(url.href));
    }
    return remoteIconColorCache.get(url.href);
}

async function applyIconColor(icon, container) {
    let localUrl;
    try {
        let color;
        try {
            // Read the already decoded favicon first; ICO bitmap decoding can differ.
            color = readIconColor(icon);
        } catch (firstError) {
            const source = new URL(icon.currentSrc || icon.src);
            const ownFavicon =
                source.protocol === "chrome-extension:" &&
                source.host === globalThis.chrome?.runtime?.id;
            if (!ownFavicon) throw firstError;
            const response = await fetch(source.href);
            if (!response.ok)
                throw new Error(`Browser favicon request failed (${response.status}).`);
            localUrl = URL.createObjectURL(await response.blob());
            const localImage = new Image();
            await new Promise((resolve, reject) => {
                localImage.onload = resolve;
                localImage.onerror = () =>
                    reject(new Error("Browser favicon could not be decoded."));
                localImage.src = localUrl;
            });
            color = readIconColor(localImage);
        }
        applyTilePreference(container, color);
        container.dataset.colorStatus = "sampled";
        container.title = `Icon background: ${color}`;
    } catch (error) {
        try {
            const color = await permittedRemoteIconColor(icon.dataset.colorSource);
            applyTilePreference(container, color);
            container.dataset.colorStatus = "sampled";
            container.title = `Icon background: ${color}`;
            return;
        } catch (remoteError) {
            error = remoteError;
        }
        const reason =
            error.name === "SecurityError"
                ? "Browser blocked reading pixels from this icon."
                : `${error.name}: ${error.message}`;
        container.dataset.colorStatus = "unavailable";
        container.title = `Icon color unavailable: ${reason}`;
        console.warn("BrowserOS icon color unavailable:", reason);
    } finally {
        if (localUrl) URL.revokeObjectURL(localUrl);
    }
}

function loadAppIcons() {
    document.querySelectorAll(".desktop-apps .app, .start-apps .app").forEach((app) => {
        const iconContainer = app.querySelector(".app-icon");
        if (!iconContainer) return;
        const website = new URL(app.href);
        if (!["http:", "https:"].includes(website.protocol)) return;
        iconContainer.classList.toggle(
            "light-icon-backing",
            /(^|\.)github\.com$/i.test(website.hostname)
        );
        applyTilePreference(iconContainer);
        const icon = document.createElement("img");
        icon.alt = "";
        icon.width = 26;
        icon.height = 26;
        icon.decoding = "async";
        icon.referrerPolicy = "no-referrer";
        const directIcon = app.dataset.icon || new URL("/favicon.ico", website.origin).href;
        icon.dataset.colorSource = directIcon;
        let triedDirectIcon = false;
        icon.addEventListener("load", () => {
            iconContainer.replaceChildren(icon);
            applyIconColor(icon, iconContainer);
        });
        icon.addEventListener("error", () => {
            if (!triedDirectIcon) {
                triedDirectIcon = true;
                console.warn(
                    "BrowserOS browser favicon unavailable; using website icon. Check that the favicon permission is approved."
                );
                icon.src = directIcon;
            }
        });
        if (globalThis.chrome?.runtime?.id && !app.dataset.icon) {
            const url = new URL(chrome.runtime.getURL("/_favicon/"));
            url.searchParams.set("pageUrl", website.href);
            url.searchParams.set("size", "32");
            icon.src = url.href;
        } else {
            triedDirectIcon = true;
            icon.src = directIcon;
        }
    });
}

// Wallpaper and media
const startApps = document.getElementById("start-apps");

const wallpaperButton = document.getElementById("change-wallpaper");
const wallpaperPicker = document.getElementById("wallpaper-picker");
let currentWallpaperUrl;

async function prepareWallpaper(file) {
    // Keep the original file: converting a GIF to canvas would lose its animation.
    const url = URL.createObjectURL(file);
    try {
        await new Promise((resolve, reject) => {
            const preview = new Image();
            preview.onload = () => resolve();
            preview.onerror = () => reject(new Error("The selected image could not load."));
            preview.src = url;
        });
        return url;
    } catch (error) {
        URL.revokeObjectURL(url);
        throw error;
    }
}

function isVideoWallpaper(file) {
    return file.type === "video/mp4" || /\.mp4$/i.test(file.name || "");
}

async function prepareWallpaperFile(file) {
    if (!isVideoWallpaper(file)) return prepareWallpaper(file);
    const url = URL.createObjectURL(file);
    const preview = document.createElement("video");
    preview.muted = true;
    preview.playsInline = true;
    preview.preload = "auto";
    try {
        await new Promise((resolve, reject) => {
            const timeout = setTimeout(() => finish(new Error("Video loading timed out.")), 15000);
            function finish(error) {
                clearTimeout(timeout);
                preview.onloadeddata = preview.onerror = null;
                error ? reject(error) : resolve();
            }
            preview.onloadeddata = () => finish();
            preview.onerror = () =>
                finish(new Error("This MP4 could not be played. Try an H.264 MP4."));
            preview.src = url;
        });
        return url;
    } catch (error) {
        URL.revokeObjectURL(url);
        throw error;
    } finally {
        preview.removeAttribute("src");
        preview.load();
    }
}

function clearWallpaperVideo() {
    const video = document.getElementById("wallpaper-video");
    if (!video) return;
    video.pause();
    video.removeAttribute("src");
    video.load();
    video.remove();
}

function applyWallpaper(url, isVideo = false) {
    document.body.classList.add("has-custom-wallpaper");
    clearWallpaperVideo();
    if (isVideo) {
        const video = document.createElement("video");
        video.id = "wallpaper-video";
        video.className = "wallpaper-video";
        video.muted = true;
        video.defaultMuted = true;
        video.loop = true;
        video.autoplay = true;
        video.playsInline = true;
        video.preload = "auto";
        video.setAttribute("aria-hidden", "true");
        video.tabIndex = -1;
        video.src = url;
        video.addEventListener("error", useDefaultWallpaper, { once: true });
        document.body.prepend(video);
        document.body.style.backgroundImage = "none";
        video.play().catch((error) => {
            console.warn("Wallpaper video playback failed:", error);
            if (video.isConnected) useDefaultWallpaper();
        });
    } else {
        document.body.style.backgroundImage = `url("${url}")`;
    }
    if (currentWallpaperUrl) URL.revokeObjectURL(currentWallpaperUrl);
    currentWallpaperUrl = url;
}

function useDefaultWallpaper() {
    document.body.classList.remove("has-custom-wallpaper");
    clearWallpaperVideo();
    document.body.style.removeProperty("background-image");
    if (currentWallpaperUrl) URL.revokeObjectURL(currentWallpaperUrl);
    currentWallpaperUrl = undefined;
}

async function restoreWallpaper() {
    try {
        const savedImage = await storedSetting("get", "wallpaper");
        if (savedImage) {
            applyWallpaper(await prepareWallpaperFile(savedImage), isVideoWallpaper(savedImage));
        } else {
            useDefaultWallpaper();
        }
    } catch (error) {
        useDefaultWallpaper();
        console.warn("Could not restore the saved wallpaper:", error);
    } finally {
        wallpaperButton.disabled = false;
        document.getElementById("default-wallpaper").disabled = false;
    }
}

wallpaperButton.addEventListener("click", () => wallpaperPicker.click());
wallpaperPicker.addEventListener("change", async () => {
    const file = wallpaperPicker.files[0];
    if (!file) return;

    wallpaperButton.disabled = true;
    document.getElementById("default-wallpaper").disabled = true;
    let nextUrl;
    try {
        nextUrl = await prepareWallpaperFile(file);
        await storedSetting("put", "wallpaper", file);
        applyWallpaper(nextUrl, isVideoWallpaper(file));
        nextUrl = undefined;
    } catch (error) {
        if (nextUrl) URL.revokeObjectURL(nextUrl);
        alert(
            "Could not save this wallpaper. Try another image or H.264 MP4, or check that browser storage is available."
        );
        console.warn("Could not save wallpaper:", error);
    } finally {
        wallpaperPicker.value = "";
        wallpaperButton.disabled = false;
        document.getElementById("default-wallpaper").disabled = false;
    }
});

// Start menu
const homeButton = document.querySelector(".home");
const startMenu = document.getElementById("start-menu");

function setStartMenuOpen(isOpen) {
    startMenu.classList.toggle("is-open", isOpen);
    homeButton.setAttribute("aria-expanded", String(isOpen));
    startMenu.setAttribute("aria-hidden", String(!isOpen));
    startMenu.inert = !isOpen;
}

homeButton.addEventListener("click", () => {
    setStartMenuOpen(!startMenu.classList.contains("is-open"));
});

document.addEventListener("click", (event) => {
    if (!startMenu.contains(event.target) && !homeButton.contains(event.target)) {
        setStartMenuOpen(false);
    }
});

document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && startMenu.classList.contains("is-open")) {
        setStartMenuOpen(false);
        homeButton.focus();
    }
});

// Profile and appearance controls
const defaultWallpaperButton = document.getElementById("default-wallpaper");
const avatarButton = document.getElementById("change-avatar");
const avatarPicker = document.getElementById("avatar-picker");
const usernameButton = document.getElementById("edit-username");
const usernameLabel = document.getElementById("username");
const settingsStatus = document.getElementById("settings-status");
let avatarUrl;

function showAvatar(url) {
    const image = new Image();
    image.alt = "";
    image.src = url;
    avatarButton.replaceChildren(image);
    if (avatarUrl) URL.revokeObjectURL(avatarUrl);
    avatarUrl = url;
}

defaultWallpaperButton.addEventListener("click", async () => {
    defaultWallpaperButton.disabled = wallpaperButton.disabled = true;
    try {
        await storedSetting("delete", "wallpaper");
        useDefaultWallpaper();
        settingsStatus.textContent = "Default wallpaper restored.";
    } catch {
        settingsStatus.textContent = "Could not save the wallpaper change. Please try again.";
    } finally {
        defaultWallpaperButton.disabled = wallpaperButton.disabled = false;
    }
});

avatarButton.addEventListener("click", () => avatarPicker.click());
avatarPicker.addEventListener("change", async () => {
    const file = avatarPicker.files[0];
    if (!file) return;
    avatarButton.disabled = true;
    let url;
    try {
        url = await prepareWallpaper(file);
        await storedSetting("put", "avatar", file);
        showAvatar(url);
        url = undefined;
        settingsStatus.textContent = "Profile picture saved.";
    } catch {
        if (url) URL.revokeObjectURL(url);
        settingsStatus.textContent = "Could not save that picture. Try another image.";
    } finally {
        avatarPicker.value = "";
        avatarButton.disabled = false;
    }
});

usernameButton.addEventListener("click", async () => {
    const answer = prompt("Enter your username:", usernameLabel.textContent);
    if (answer === null) return;
    const name = answer.trim().slice(0, 40) || "user";
    usernameButton.disabled = true;
    try {
        await storedSetting("put", "username", name);
        usernameLabel.textContent = name;
        settingsStatus.textContent = "Username saved.";
    } catch {
        settingsStatus.textContent = "Could not save your username. Please try again.";
    } finally {
        usernameButton.disabled = false;
    }
});

async function restoreProfile() {
    // A normal web page cannot read the computer's or Brave profile's username.
    try {
        const name = await storedSetting("get", "username");
        usernameLabel.textContent = typeof name === "string" && name.trim() ? name : "user";
    } catch {
        /* Keep the default username. */
    }
    try {
        const avatar = await storedSetting("get", "avatar");
        if (avatar) showAvatar(await prepareWallpaper(avatar));
    } catch {
        /* Keep the default gray Lucide person icon. */
    }
    avatarButton.disabled = usernameButton.disabled = false;
}

// App view and search
const appViewButtons = document.querySelectorAll("[data-app-view]");

function applyAppView(view) {
    startApps.classList.toggle("is-list", view === "list");
    appViewButtons.forEach((button) => {
        button.setAttribute("aria-pressed", String(button.dataset.appView === view));
    });
}

appViewButtons.forEach((button) => {
    button.addEventListener("click", async () => {
        const view = button.dataset.appView;
        applyAppView(view);
        appViewButtons.forEach((item) => {
            item.disabled = true;
        });
        try {
            await storedSetting("put", "appView", view);
        } catch {
            settingsStatus.textContent = "View changed, but could not be saved for next time.";
        } finally {
            appViewButtons.forEach((item) => {
                item.disabled = false;
            });
        }
    });
});

async function restoreAppView() {
    try {
        const view = await storedSetting("get", "appView");
        applyAppView(view === "list" ? "list" : "grid");
    } catch {
        applyAppView("grid");
    } finally {
        appViewButtons.forEach((button) => {
            button.disabled = false;
        });
    }
}

const appSearch = document.getElementById("app-search");
const appSearchEmpty = document.getElementById("app-search-empty");

appSearch.addEventListener("input", () => {
    const query = appSearch.value.trim().toLocaleLowerCase();
    let matches = 0;
    startApps.querySelectorAll(".app").forEach((app) => {
        const name = app.querySelector(".app-name").textContent.toLocaleLowerCase();
        const visible = name.includes(query);
        app.hidden = !visible;
        if (visible) matches++;
    });
    appSearchEmpty.hidden = matches > 0;
    startApps.scrollTop = 0;
});

// Desktop grid and dragging
// Desktop shortcuts snap to individual cells, leaving empty cells available.
const desktopApps = document.querySelector(".desktop-apps");
let desktopShortcuts = [...desktopApps.querySelectorAll(".app")];
const desktopPositions = new Map();
let draggedApp = null;
let blockDesktopClick = false;
let desktopReady = false;
let desktopSave = Promise.resolve();
const duplicateLinks = new Map();

desktopShortcuts.forEach((app) => {
    const occurrence = duplicateLinks.get(app.href) || 0;
    duplicateLinks.set(app.href, occurrence + 1);
    app.dataset.desktopKey = `${app.href}#${occurrence}`;
    app.draggable = true;
});

const dropPreview = document.createElement("div");
dropPreview.className = "desktop-drop-preview";
dropPreview.hidden = true;
dropPreview.setAttribute("aria-hidden", "true");
desktopApps.append(dropPreview);

function desktopGridSize() {
    const style = getComputedStyle(desktopApps);
    const width =
        desktopApps.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight);
    const height =
        desktopApps.clientHeight - parseFloat(style.paddingTop) - parseFloat(style.paddingBottom);
    const cellWidth = parseFloat(style.getPropertyValue("--desktop-cell-width"));
    const cellHeight = parseFloat(style.getPropertyValue("--desktop-cell-height"));
    const gap = parseFloat(style.columnGap);
    return {
        columns: Math.max(1, Math.floor((width + gap) / (cellWidth + gap))),
        rows: Math.max(1, Math.floor((height + gap) / (cellHeight + gap))),
        cellWidth,
        cellHeight,
        gap,
        style
    };
}

function renderDesktopPositions() {
    const grid = desktopGridSize();
    desktopApps.style.gridTemplateRows = `repeat(${grid.rows}, var(--desktop-cell-height))`;
    desktopApps.style.gridTemplateColumns = `repeat(${grid.columns}, var(--desktop-cell-width))`;
    const occupied = new Set();
    desktopShortcuts.forEach((app) => {
        const preferred = desktopPositions.get(app.dataset.desktopKey);
        let column = preferred ? Math.min(preferred.column, grid.columns) : 1;
        let row = preferred ? Math.min(preferred.row, grid.rows) : 1;
        if (!preferred || occupied.has(`${column}:${row}`)) {
            let slot = 0;
            do {
                column = Math.floor(slot / grid.rows) + 1;
                row = (slot % grid.rows) + 1;
                slot++;
            } while (occupied.has(`${column}:${row}`));
        }
        occupied.add(`${column}:${row}`);
        app.style.gridColumn = column;
        app.style.gridRow = row;
        if (!preferred) desktopPositions.set(app.dataset.desktopKey, { column, row });
    });
}

function desktopDropCell(event) {
    const grid = desktopGridSize();
    const bounds = desktopApps.getBoundingClientRect();
    const x =
        event.clientX - bounds.left + desktopApps.scrollLeft - parseFloat(grid.style.paddingLeft);
    const y =
        event.clientY - bounds.top + desktopApps.scrollTop - parseFloat(grid.style.paddingTop);
    const columns = Math.max(
        grid.columns,
        ...desktopShortcuts.map((app) => Number(app.style.gridColumn))
    );
    return {
        column: Math.max(
            1,
            Math.min(columns, Math.floor((x + grid.gap / 2) / (grid.cellWidth + grid.gap)) + 1)
        ),
        row: Math.max(
            1,
            Math.min(grid.rows, Math.floor((y + grid.gap / 2) / (grid.cellHeight + grid.gap)) + 1)
        )
    };
}

desktopApps.addEventListener("dragstart", (event) => {
    const app = event.target.closest(".app");
    if (!app || !desktopReady) {
        event.preventDefault();
        return;
    }
    draggedApp = app;
    blockDesktopClick = true;
    event.dataTransfer.effectAllowed = "move";
    event.dataTransfer.setData("text/plain", app.dataset.desktopKey);
    app.classList.add("is-dragging");
});

desktopApps.addEventListener("dragover", (event) => {
    if (!draggedApp) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = "move";
    const cell = desktopDropCell(event);
    dropPreview.style.gridColumn = cell.column;
    dropPreview.style.gridRow = cell.row;
    dropPreview.hidden = false;
});

desktopApps.addEventListener("dragleave", (event) => {
    if (!desktopApps.contains(event.relatedTarget)) dropPreview.hidden = true;
});

desktopApps.addEventListener("drop", (event) => {
    if (!draggedApp) return;
    event.preventDefault();
    const destination = desktopDropCell(event);
    const origin = {
        column: Number(draggedApp.style.gridColumn),
        row: Number(draggedApp.style.gridRow)
    };
    const occupant = desktopShortcuts.find(
        (app) =>
            app !== draggedApp &&
            Number(app.style.gridColumn) === destination.column &&
            Number(app.style.gridRow) === destination.row
    );
    // Dropping onto another shortcut swaps the two cells.
    if (occupant) desktopPositions.set(occupant.dataset.desktopKey, origin);
    desktopPositions.set(draggedApp.dataset.desktopKey, destination);
    renderDesktopPositions();
    dropPreview.hidden = true;
    const snapshot = Object.fromEntries(desktopPositions);
    desktopSave = desktopSave
        .then(() => storedSetting("put", "desktopLayout", { positions: snapshot }))
        .catch(() => {
            alert("App moved, but its position could not be saved for next time.");
        });
});

desktopApps.addEventListener("dragend", () => {
    if (draggedApp) draggedApp.classList.remove("is-dragging");
    draggedApp = null;
    dropPreview.hidden = true;
    setTimeout(() => {
        blockDesktopClick = false;
    }, 0);
});

desktopApps.addEventListener(
    "click",
    (event) => {
        if (blockDesktopClick) {
            event.preventDefault();
            event.stopPropagation();
        }
    },
    true
);

async function restoreDesktopPositions() {
    try {
        const layout = await storedSetting("get", "desktopLayout");
        const saved = layout?.positions || (await storedSetting("get", "desktopAppPositions"));
        if (saved && typeof saved === "object") {
            desktopShortcuts.forEach((app) => {
                const cell = saved[app.dataset.desktopKey];
                if (
                    cell &&
                    Number.isInteger(cell.column) &&
                    Number.isInteger(cell.row) &&
                    cell.column > 0 &&
                    cell.row > 0
                ) {
                    desktopPositions.set(app.dataset.desktopKey, cell);
                }
            });
        }
    } catch {
        /* Use the default cells when storage is unavailable. */
    }
    renderDesktopPositions();
    desktopReady = true;
}
new ResizeObserver(() => {
    if (desktopReady) renderDesktopPositions();
}).observe(desktopApps);

// App catalog and bookmarks
const addAppButton = document.getElementById("add-app");
const appEditor = document.getElementById("app-editor");
const appForm = document.getElementById("app-form");
const appNameInput = document.getElementById("app-name-input");
const appUrlInput = document.getElementById("app-url-input");
const appFormError = document.getElementById("app-form-error");
const saveAppButton = document.getElementById("save-app");
const appOptions = document.getElementById("app-options");
let appCatalog = [];
let bookmarkApps = [];
let hiddenBookmarkIds = new Set();
let bookmarkRefreshTimer;
const bookmarksApi = globalThis.chrome?.bookmarks;

function visibleAppRecords() {
    const seen = new Set();
    return [...appCatalog, ...bookmarkApps].filter((app) => {
        if (hiddenBookmarkIds.has(app.id)) return false;
        const key = normalizeAppUrl(app.url);
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
    });
}

function bookmarkRecords(tree) {
    const records = [];
    function visit(nodes) {
        for (const node of nodes) {
            if (node.url) {
                try {
                    const url = normalizeAppUrl(node.url);
                    records.push({
                        id: `bookmark:${node.id}`,
                        name: node.title?.trim() || new URL(url).hostname,
                        url,
                        icon: ""
                    });
                } catch {
                    /* Skip bookmarklets and non-web addresses. */
                }
            }
            if (node.children) visit(node.children);
        }
    }
    visit(tree);
    return records;
}

async function refreshBookmarks(render = true) {
    if (!bookmarksApi) return;
    try {
        bookmarkApps = bookmarkRecords(await bookmarksApi.getTree());
        if (render) renderAppCatalog();
    } catch (error) {
        console.warn("Could not read browser bookmarks:", error);
        settingsStatus.textContent =
            "Bookmarks could not load. Check the extension's bookmarks permission.";
    }
}

function scheduleBookmarkRefresh() {
    clearTimeout(bookmarkRefreshTimer);
    bookmarkRefreshTimer = setTimeout(() => {
        if (catalogBusy || draggedApp || appEditor.open || removalDialog.open) {
            scheduleBookmarkRefresh();
            return;
        }
        refreshBookmarks();
    }, 200);
}

let editingAppId = null;
let selectedAppId = null;
let appOptionsOpener;
let catalogBusy = false;

function normalizeAppUrl(value) {
    const text = value.trim();
    const url = new URL(/^[a-z][a-z0-9+.-]*:/i.test(text) ? text : `https://${text}`);
    if (!["http:", "https:"].includes(url.protocol) || !url.hostname) {
        throw new Error("Enter a website address using http or https.");
    }
    return url.href;
}

function createAppShortcut(record) {
    const app = document.createElement("a");
    app.className = "app";
    app.href = record.url;
    app.dataset.desktopKey = record.id;
    app.dataset.appId = record.id;
    if (record.icon) app.dataset.icon = record.icon;
    const icon = document.createElement("span");
    icon.className = "app-icon";
    icon.setAttribute("aria-hidden", "true");
    icon.textContent = record.name.slice(0, 2).toUpperCase();
    const name = document.createElement("span");
    name.className = "app-name";
    name.textContent = record.name;
    app.append(icon, name);
    applyTilePreference(icon);
    return app;
}

function renderAppCatalog() {
    desktopShortcuts.forEach((app) => app.remove());
    startApps.replaceChildren();
    desktopShortcuts = visibleAppRecords().map((record) => {
        const app = createAppShortcut(record);
        app.draggable = true;
        desktopApps.insertBefore(app, dropPreview);
        startApps.append(createAppShortcut(record));
        return app;
    });
    loadAppIcons();
    if (desktopReady) renderDesktopPositions();
    appSearch.dispatchEvent(new Event("input"));
}

async function initializeApps() {
    try {
        const preferences = await storedSetting("get", "iconTilePreferences");
        if (preferences && typeof preferences === "object" && !Array.isArray(preferences)) {
            iconTilePreferences = Object.assign(Object.create(null), preferences);
        }
    } catch {
        /* Use automatically sampled backgrounds. */
    }
    // Preserve the three shipped apps and existing manually added shortcuts.
    const defaultApps = desktopShortcuts.map((app) => ({
        id: app.dataset.desktopKey,
        name: app.querySelector(".app-name").textContent,
        url: app.href,
        icon: app.dataset.icon || ""
    }));
    appCatalog = defaultApps;
    try {
        const library = await storedSetting("get", "appLibrary");
        hiddenBookmarkIds = new Set(
            Array.isArray(library?.hiddenBookmarkIds) ? library.hiddenBookmarkIds : []
        );
        const saved = library?.apps || (await storedSetting("get", "appCatalog"));
        if (Array.isArray(saved)) {
            appCatalog = saved.filter((record) => {
                try {
                    return (
                        typeof record.id === "string" &&
                        typeof record.name === "string" &&
                        record.name.trim() &&
                        normalizeAppUrl(record.url)
                    );
                } catch {
                    return false;
                }
            });
        }
    } catch {
        /* Show the default apps if storage is unavailable. */
    }
    for (const defaultApp of defaultApps) {
        if (!appCatalog.some((app) => app.id === defaultApp.id || app.url === defaultApp.url))
            appCatalog.push(defaultApp);
    }
    await refreshBookmarks(false);
    renderAppCatalog();
    await restoreDesktopPositions();
    if (bookmarksApi) {
        for (const event of [
            bookmarksApi.onCreated,
            bookmarksApi.onRemoved,
            bookmarksApi.onChanged,
            bookmarksApi.onMoved,
            bookmarksApi.onChildrenReordered,
            bookmarksApi.onImportEnded
        ]) {
            event?.addListener(scheduleBookmarkRefresh);
        }
    }
    addAppButton.disabled = false;
}

function closeAppOptions(restoreFocus = false) {
    appOptions.hidden = true;
    if (restoreFocus && appOptionsOpener?.isConnected) appOptionsOpener.focus();
}

function openAppEditor(record = null) {
    closeAppOptions();
    editingAppId = record?.id || null;
    document.getElementById("app-editor-title").textContent = record ? "Edit app" : "Add app";
    appNameInput.value = record?.name || "";
    appUrlInput.value = record?.url || "";
    appFormError.textContent = "";
    appEditor.showModal();
    appNameInput.focus();
}

addAppButton.addEventListener("click", () => openAppEditor());
document.getElementById("cancel-app").addEventListener("click", () => appEditor.close());
appEditor.addEventListener("cancel", (event) => {
    if (catalogBusy) event.preventDefault();
});
appForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    if (catalogBusy) return;
    let url;
    const name = appNameInput.value.trim();
    if (!name) {
        appFormError.textContent = "Enter an app name.";
        return;
    }
    try {
        url = normalizeAppUrl(appUrlInput.value);
    } catch {
        appFormError.textContent = "Enter a valid website address, such as https://example.com.";
        return;
    }
    const id = editingAppId || crypto.randomUUID();
    const old = visibleAppRecords().find((record) => record.id === id);
    const record = { id, name, url, icon: old?.url === url ? old.icon : "" };
    const next = appCatalog.some((app) => app.id === id)
        ? appCatalog.map((app) => (app.id === id ? record : app))
        : [...appCatalog, record];
    catalogBusy = true;
    saveAppButton.disabled = document.getElementById("cancel-app").disabled = true;
    try {
        await storedSetting("put", "appLibrary", {
            apps: next,
            hiddenBookmarkIds: [...hiddenBookmarkIds]
        });
        appCatalog = next;
        renderAppCatalog();
        appEditor.close();
    } catch {
        appFormError.textContent =
            "Could not save the app. Check that browser storage is available and try again.";
    } finally {
        catalogBusy = false;
        saveAppButton.disabled = document.getElementById("cancel-app").disabled = false;
    }
});

function showAppOptions(event) {
    const app = event.target.closest(".app");
    if (!app || !desktopReady || catalogBusy) return;
    event.preventDefault();
    selectedAppId = app.dataset.appId;
    appOptionsOpener = app;
    updateTileOptions(app);
    appOptions.hidden = false;
    appOptions.style.left = `${Math.max(8, Math.min(event.clientX, innerWidth - appOptions.offsetWidth - 8))}px`;
    appOptions.style.top = `${Math.max(8, Math.min(event.clientY, innerHeight - appOptions.offsetHeight - 8))}px`;
    document.getElementById("edit-app").focus();
}
desktopApps.addEventListener("contextmenu", showAppOptions);
startApps.addEventListener("contextmenu", showAppOptions);
document.getElementById("edit-app").addEventListener("click", () => {
    const record = visibleAppRecords().find((app) => app.id === selectedAppId);
    if (record) openAppEditor(record);
});
// Per-app tile preferences
function updateTileOptions(app) {
    const mode = iconTilePreferences[app.dataset.appId] || "auto";
    const sampled = (app.querySelector(".app-icon").dataset.sampledColor || "").replace(/\s/g, "");
    const reverse = document.getElementById("reverse-tile-color");
    reverse.disabled =
        tilePreferenceBusy ||
        mode === "default" ||
        !["rgb(0,0,0)", "rgb(255,255,255)"].includes(sampled);
    reverse.setAttribute("aria-checked", String(mode === "reverse"));
    const enableButton = document.getElementById("enable-icon-color");
    enableButton.setAttribute("aria-checked", String(mode !== "default"));
    enableButton.disabled = tilePreferenceBusy;
}

async function saveTilePreference(mode, id = selectedAppId) {
    if (tilePreferenceBusy || !id) return false;
    tilePreferenceBusy = true;
    closeAppOptions();
    const next = Object.assign(Object.create(null), iconTilePreferences);
    if (mode === "auto") delete next[id];
    else next[id] = mode;
    try {
        await storedSetting("put", "iconTilePreferences", next);
        iconTilePreferences = next;
        document.querySelectorAll(".app").forEach((app) => {
            if (app.dataset.appId === id) applyTilePreference(app.querySelector(".app-icon"));
        });
        return true;
    } catch {
        alert("Could not save the tile background. Please try again.");
        return false;
    } finally {
        tilePreferenceBusy = false;
    }
}

document.getElementById("reverse-tile-color").addEventListener("click", () => {
    saveTilePreference(iconTilePreferences[selectedAppId] === "reverse" ? "auto" : "reverse");
});

document.getElementById("enable-icon-color").addEventListener("click", async () => {
    if (tilePreferenceBusy) return;
    const record = visibleAppRecords().find((app) => app.id === selectedAppId);
    if (!record) return;
    // Checked means icon-derived color; unchecked follows the current theme.
    if (iconTilePreferences[record.id] !== "default") {
        await saveTilePreference("default", record.id);
        return;
    }
    const sampled = appOptionsOpener?.querySelector(".app-icon")?.dataset.sampledColor;
    if (sampled) {
        await saveTilePreference("auto", record.id);
        return;
    }
    const iconAddress = record.icon || new URL("/favicon.ico", record.url).href;
    const url = new URL(iconAddress);
    if (!["http:", "https:"].includes(url.protocol) || !globalThis.chrome?.permissions) {
        alert("This option works when BrowserOS is loaded as an extension.");
        return;
    }
    const runningManifest = chrome.runtime.getManifest();
    const optionalHosts = runningManifest.optional_host_permissions || [];
    const schemePattern = `${url.protocol}//*/*`;
    const exactPattern = `${url.protocol}//${url.hostname}/*`;
    if (
        !optionalHosts.includes(schemePattern) &&
        !optionalHosts.includes(exactPattern) &&
        !optionalHosts.includes("<all_urls>")
    ) {
        closeAppOptions();
        alert(
            `The running extension (version ${runningManifest.version}) has an older manifest. Open brave://extensions, reload BrowserOS from the original Browser OS folder, then close this tab and open a fresh new tab.`
        );
        return;
    }
    // Request only the selected icon's website, directly from this button click.
    const request = chrome.permissions.request({ origins: [exactPattern] });
    closeAppOptions();
    try {
        if (!(await request)) return;
        const color = await permittedRemoteIconColor(iconAddress);
        if (!(await saveTilePreference("auto", record.id))) return;
        document.querySelectorAll(".app").forEach((app) => {
            if (app.dataset.appId !== record.id) return;
            const tile = app.querySelector(".app-icon");
            applyTilePreference(tile, color);
            tile.dataset.colorStatus = "sampled";
            tile.title = `Icon background: ${color}`;
        });
    } catch (error) {
        alert(`Could not sample this icon: ${error.message}`);
    }
});

// App and bookmark removal
const removalDialog = document.getElementById("remove-app-dialog");
const removalForm = document.getElementById("remove-app-form");
const removalError = document.getElementById("remove-app-error");
const removalConfirm = document.getElementById("confirm-remove-app");
let removalRecord = null;
let removalBookmarks = [];

function matchingBookmarks(record) {
    return bookmarkApps.filter(
        (bookmark) => normalizeAppUrl(bookmark.url) === normalizeAppUrl(record.url)
    );
}

function updateRemovalChoice() {
    const mode = removalForm.elements["remove-mode"].value;
    const count = removalBookmarks.length;
    removalConfirm.textContent =
        mode === "app" ? "Remove app" : mode === "bookmark" ? "Delete bookmark" : "Delete both";
    document.getElementById("remove-app-note").textContent =
        mode === "app"
            ? "This hides the app from the desktop and start menu. Your Brave bookmarks stay saved."
            : `This will delete ${count} matching Brave bookmark${count === 1 ? "" : "s"}. ${mode === "bookmark" ? "The app will stay saved in BrowserOS." : "The app will also be removed from BrowserOS."}`;
}

removalForm.addEventListener("change", updateRemovalChoice);
document.getElementById("remove-app").addEventListener("click", async () => {
    if (catalogBusy) return;
    removalRecord = visibleAppRecords().find((app) => app.id === selectedAppId);
    closeAppOptions();
    if (!removalRecord) return;
    await refreshBookmarks(false);
    removalBookmarks = matchingBookmarks(removalRecord);
    removalForm.reset();
    removalError.textContent = "";
    document.getElementById("remove-app-description").textContent =
        `Choose what to remove for “${removalRecord.name}”.`;
    removalForm
        .querySelectorAll('input[value="bookmark"], input[value="both"]')
        .forEach((input) => {
            input.disabled = !bookmarksApi || removalBookmarks.length === 0;
        });
    updateRemovalChoice();
    removalDialog.showModal();
});

document.getElementById("cancel-remove-app").addEventListener("click", () => removalDialog.close());
removalDialog.addEventListener("cancel", (event) => {
    if (catalogBusy) event.preventDefault();
});
removalForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    if (catalogBusy || !removalRecord) return;
    const mode = removalForm.elements["remove-mode"].value;
    if (mode !== "app" && (!bookmarksApi || !removalBookmarks.length)) return;
    catalogBusy = true;
    removalConfirm.disabled = document.getElementById("cancel-remove-app").disabled = true;
    removalForm.querySelectorAll("input").forEach((input) => {
        input.disabled = true;
    });
    removalError.textContent = "";
    let localSaved = false;
    let deleted = 0;
    try {
        const record = removalRecord;
        let next = [...appCatalog];
        const hidden = new Set(hiddenBookmarkIds);
        if (mode === "bookmark") {
            // Retain imported bookmarks as independent apps before deleting the bookmark.
            if (!next.some((app) => app.id === record.id)) next.push({ ...record });
            hidden.delete(record.id);
        } else {
            const sameUrl = (app) => normalizeAppUrl(app.url) === normalizeAppUrl(record.url);
            for (const app of [...appCatalog, ...bookmarkApps].filter(sameUrl)) hidden.add(app.id);
            hidden.add(record.id);
            next = next.filter((app) => !sameUrl(app));
        }
        await storedSetting("put", "appLibrary", { apps: next, hiddenBookmarkIds: [...hidden] });
        appCatalog = next;
        hiddenBookmarkIds = hidden;
        localSaved = true;
        if (mode !== "app") {
            for (const bookmark of removalBookmarks) {
                await bookmarksApi.remove(bookmark.id.slice("bookmark:".length));
                deleted++;
            }
        }
        if (mode !== "bookmark") desktopPositions.delete(record.id);
        await refreshBookmarks(false);
        renderAppCatalog();
        removalDialog.close();
    } catch (error) {
        await refreshBookmarks(false);
        renderAppCatalog();
        removalError.textContent = localSaved
            ? `The app change was saved, but bookmark deletion did not finish (${deleted} deleted). Check Brave bookmarks before retrying.`
            : "Nothing was deleted. Could not save the app change; please try again.";
        console.warn("Removal could not finish:", error);
    } finally {
        catalogBusy = false;
        removalConfirm.disabled = document.getElementById("cancel-remove-app").disabled = false;
        removalBookmarks = removalRecord ? matchingBookmarks(removalRecord) : [];
        removalForm.querySelectorAll("input").forEach((input) => {
            input.disabled = input.value !== "app" && (!bookmarksApi || !removalBookmarks.length);
        });
        updateRemovalChoice();
    }
});

document.addEventListener("pointerdown", (event) => {
    if (!appOptions.contains(event.target)) closeAppOptions();
});
document.addEventListener("keydown", (event) => {
    if (appOptions.hidden) return;
    if (event.key === "Escape") {
        event.preventDefault();
        closeAppOptions(true);
    }
    if (["ArrowDown", "ArrowUp"].includes(event.key)) {
        event.preventDefault();
        const buttons = [...appOptions.querySelectorAll("button:not(:disabled)")];
        const direction = event.key === "ArrowDown" ? 1 : -1;
        const index = buttons.indexOf(document.activeElement);
        buttons[(index + direction + buttons.length) % buttons.length].focus();
    }
    if (event.key === "Tab") closeAppOptions();
});
window.addEventListener("resize", () => closeAppOptions());
window.addEventListener("blur", () => closeAppOptions());

// Theme
const themeToggle = document.getElementById("theme-toggle");

function applyTheme(theme) {
    const light = theme === "light";
    document.documentElement.dataset.theme = light ? "light" : "dark";
    const label = light ? "Switch to dark mode" : "Switch to light mode";
    themeToggle.setAttribute("aria-label", label);
    themeToggle.title = label;
}

async function restoreTheme() {
    try {
        applyTheme(await storedSetting("get", "theme"));
    } catch {
        applyTheme("dark");
    }
    themeToggle.disabled = false;
}

themeToggle.addEventListener("click", async () => {
    const previous = document.documentElement.dataset.theme || "dark";
    const next = previous === "dark" ? "light" : "dark";
    applyTheme(next);
    themeToggle.disabled = true;
    try {
        await storedSetting("put", "theme", next);
    } catch {
        applyTheme(previous);
        alert("Could not save the theme. Please try again.");
    } finally {
        themeToggle.disabled = false;
    }
});

// Background music
const musicPicker = document.getElementById("music-picker");
const chooseMusicButton = document.getElementById("choose-music");
const muteMusicButton = document.getElementById("mute-music");
const musicStatus = document.getElementById("music-status");
const backgroundMusic = new Audio();
backgroundMusic.loop = true;
backgroundMusic.preload = "metadata";
let musicUrl;
let musicMuted = false;
let musicWaitingForGesture = false;
let musicBusy = false;

function updateMusicButton() {
    muteMusicButton.disabled = !musicUrl || musicBusy;
    muteMusicButton.setAttribute("aria-pressed", String(musicMuted));
    muteMusicButton.classList.toggle("is-muted", musicMuted);
    const label = !musicUrl
        ? "Choose music first"
        : musicMuted
          ? "Unmute background music"
          : musicWaitingForGesture
            ? "Play background music"
            : "Mute background music";
    muteMusicButton.title = label;
    muteMusicButton.setAttribute("aria-label", label);
}

async function playBackgroundMusic() {
    if (!musicUrl || musicMuted) return;
    try {
        await backgroundMusic.play();
        musicWaitingForGesture = false;
        musicStatus.textContent = "Background music playing.";
    } catch (error) {
        musicWaitingForGesture = error.name === "NotAllowedError";
        musicStatus.textContent = musicWaitingForGesture
            ? "Click the tab to start background music."
            : "This audio could not be played. Choose another file.";
    }
    updateMusicButton();
}

async function prepareMusic(file) {
    const url = URL.createObjectURL(file);
    const preview = new Audio();
    preview.preload = "metadata";
    try {
        await new Promise((resolve, reject) => {
            const timer = setTimeout(() => finish(new Error("Audio loading timed out.")), 10000);
            function finish(error) {
                clearTimeout(timer);
                preview.onloadedmetadata = preview.onerror = null;
                error ? reject(error) : resolve();
            }
            preview.onloadedmetadata = () => finish();
            preview.onerror = () => finish(new Error("Unsupported audio file."));
            preview.src = url;
        });
        return url;
    } catch (error) {
        URL.revokeObjectURL(url);
        throw error;
    } finally {
        preview.removeAttribute("src");
        preview.load();
    }
}

function applyMusic(url, name) {
    backgroundMusic.pause();
    backgroundMusic.removeAttribute("src");
    backgroundMusic.load();
    if (musicUrl) URL.revokeObjectURL(musicUrl);
    musicUrl = url;
    backgroundMusic.src = url;
    backgroundMusic.muted = musicMuted;
    chooseMusicButton.title = `Change music: ${name || "Saved track"}`;
    musicWaitingForGesture = !musicMuted;
    updateMusicButton();
    if (!musicMuted) playBackgroundMusic();
}

async function restoreMusic() {
    try {
        musicMuted = (await storedSetting("get", "musicMuted")) === true;
        backgroundMusic.muted = musicMuted;
        const file = await storedSetting("get", "musicFile");
        if (file) applyMusic(await prepareMusic(file), file.name);
    } catch {
        musicStatus.textContent = "Saved music could not load. Choose another audio file.";
    } finally {
        chooseMusicButton.disabled = false;
        updateMusicButton();
    }
}

chooseMusicButton.addEventListener("click", () => musicPicker.click());
musicPicker.addEventListener("change", async () => {
    const file = musicPicker.files[0];
    if (!file || musicBusy) return;
    musicBusy = true;
    chooseMusicButton.disabled = true;
    updateMusicButton();
    let url;
    try {
        url = await prepareMusic(file);
        await storedSetting("put", "musicFile", file);
        applyMusic(url, file.name);
        url = undefined;
    } catch {
        if (url) URL.revokeObjectURL(url);
        alert(
            "Could not save this music. Try an MP3, M4A, OGG, or WAV file and check browser storage."
        );
    } finally {
        musicPicker.value = "";
        musicBusy = false;
        chooseMusicButton.disabled = false;
        updateMusicButton();
    }
});
muteMusicButton.addEventListener("click", async () => {
    if (!musicUrl || musicBusy) return;
    // A blocked track's Play button starts it without changing the mute preference.
    if (musicWaitingForGesture && !musicMuted) {
        playBackgroundMusic();
        return;
    }
    musicMuted = !musicMuted;
    backgroundMusic.muted = musicMuted;
    if (musicMuted) {
        backgroundMusic.pause();
        musicWaitingForGesture = false;
    } else {
        playBackgroundMusic();
    }
    updateMusicButton();
    musicBusy = true;
    updateMusicButton();
    try {
        await storedSetting("put", "musicMuted", musicMuted);
    } catch {
        musicStatus.textContent = "Mute changed, but could not be saved for the next tab.";
    } finally {
        musicBusy = false;
        updateMusicButton();
    }
});
function resumeMusicOnInteraction(event) {
    if (event.target.closest?.("#mute-music, #choose-music")) return;
    if (musicWaitingForGesture && !musicMuted) playBackgroundMusic();
}
document.addEventListener("click", resumeMusicOnInteraction);
document.addEventListener("keydown", (event) => {
    if (event.isTrusted && musicWaitingForGesture && !musicMuted) playBackgroundMusic();
});
backgroundMusic.addEventListener("error", () => {
    musicWaitingForGesture = false;
    musicStatus.textContent = "Music could not play. Choose another audio file.";
    updateMusicButton();
});

// Loading cover
async function revealDesktop() {
    const pageLoaded =
        document.readyState === "complete"
            ? Promise.resolve()
            : new Promise((resolve) => window.addEventListener("load", resolve, { once: true }));
    await Promise.allSettled([
        pageLoaded,
        restoreThemeReady,
        restoreDesktopClockReady,
        restoreMusicReady,
        restoreWallpaperReady,
        restoreProfileReady,
        restoreAppViewReady,
        initializeAppsReady
    ]);
    document.body.classList.remove("is-loading");
    document.body.setAttribute("aria-busy", "false");
    document.getElementById("tab-loading").remove();
}

// Calendar
const calendarToggle = document.getElementById("calendar-toggle");
const calendarPanel = document.getElementById("calendar-panel");
let calendarMonth = new Date();
calendarMonth = new Date(calendarMonth.getFullYear(), calendarMonth.getMonth(), 1);

function calendarDates(year, month) {
    const offset = new Date(year, month, 1).getDay();
    const total = new Date(year, month + 1, 0).getDate();
    return [...Array(offset).fill(null), ...Array.from({ length: total }, (_, index) => index + 1)];
}

function renderCalendar() {
    const year = calendarMonth.getFullYear();
    const month = calendarMonth.getMonth();
    const today = new Date();
    document.getElementById("calendar-month").textContent = calendarMonth.toLocaleDateString([], {
        month: "long",
        year: "numeric"
    });
    const weekdays = document.getElementById("calendar-weekdays");
    weekdays.replaceChildren();
    for (let day = 0; day < 7; day++) {
        const label = document.createElement("span");
        label.textContent = new Date(2024, 0, 7 + day).toLocaleDateString([], {
            weekday: "narrow"
        });
        weekdays.append(label);
    }
    const days = document.getElementById("calendar-days");
    days.replaceChildren();
    calendarDates(year, month).forEach((day) => {
        const cell = document.createElement("span");
        cell.className = "calendar-day";
        if (day) {
            cell.textContent = day;
            cell.setAttribute(
                "aria-label",
                new Date(year, month, day).toLocaleDateString([], { dateStyle: "full" })
            );
            if (
                day === today.getDate() &&
                month === today.getMonth() &&
                year === today.getFullYear()
            ) {
                cell.classList.add("is-today");
                cell.setAttribute("aria-current", "date");
            }
        } else {
            cell.setAttribute("aria-hidden", "true");
        }
        days.append(cell);
    });
}

function closeCalendar(restoreFocus = false) {
    calendarPanel.hidden = true;
    calendarToggle.setAttribute("aria-expanded", "false");
    if (restoreFocus) calendarToggle.focus();
}
calendarToggle.addEventListener("click", () => {
    if (!calendarPanel.hidden) {
        closeCalendar();
        return;
    }
    setStartMenuOpen(false);
    const now = new Date();
    calendarMonth = new Date(now.getFullYear(), now.getMonth(), 1);
    renderCalendar();
    calendarPanel.hidden = false;
    calendarToggle.setAttribute("aria-expanded", "true");
});
document.getElementById("calendar-prev").addEventListener("click", () => {
    calendarMonth = new Date(calendarMonth.getFullYear(), calendarMonth.getMonth() - 1, 1);
    renderCalendar();
});
document.getElementById("calendar-next").addEventListener("click", () => {
    calendarMonth = new Date(calendarMonth.getFullYear(), calendarMonth.getMonth() + 1, 1);
    renderCalendar();
});
document.getElementById("calendar-today").addEventListener("click", () => {
    const now = new Date();
    calendarMonth = new Date(now.getFullYear(), now.getMonth(), 1);
    renderCalendar();
});
document.addEventListener("click", (event) => {
    if (!calendarPanel.contains(event.target) && !calendarToggle.contains(event.target))
        closeCalendar();
});
document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && !calendarPanel.hidden) {
        closeCalendar(true);
    }
});

// Desktop weekday/date/time widget
const desktopClock = document.getElementById("desktop-clock");
const desktopClockToggle = document.getElementById("toggle-desktop-clock");
const desktopClockResize = document.getElementById("resize-desktop-clock");
const desktopClockDefaults = Object.freeze({
    visible: true,
    x: null,
    y: 24,
    width: 380,
    height: 180,
    color: null
});
let desktopClockState = { ...desktopClockDefaults };
let desktopClockGesture = null;
let desktopClockSave = Promise.resolve();

function desktopClockLayout(state, viewportWidth, viewportHeight) {
    const margin = 16;
    const maxWidth = Math.max(1, viewportWidth - margin * 2);
    const maxHeight = Math.max(1, viewportHeight - 104);
    const width = Math.min(maxWidth, Math.max(230, state.width));
    const height = Math.min(maxHeight, Math.max(130, state.height));
    const maxX = Math.max(margin, viewportWidth - width - margin);
    const maxY = Math.max(margin, viewportHeight - height - 88);
    const x = Math.max(margin, Math.min(state.x ?? viewportWidth - width - 24, maxX));
    const y = Math.max(margin, Math.min(state.y, maxY));
    return { x, y, width, height };
}

function renderDesktopClock() {
    const layout = desktopClockLayout(desktopClockState, innerWidth, innerHeight);
    desktopClock.style.left = `${layout.x}px`;
    desktopClock.style.top = `${layout.y}px`;
    desktopClock.style.width = `${layout.width}px`;
    desktopClock.style.height = `${layout.height}px`;
    desktopClock.hidden = !desktopClockState.visible;
    if (desktopClockState.color) desktopClock.style.color = desktopClockState.color;
    else desktopClock.style.removeProperty("color");
    desktopClockToggle.setAttribute("aria-pressed", String(desktopClockState.visible));
    const label = desktopClockState.visible ? "Hide desktop clock" : "Show desktop clock";
    desktopClockToggle.title = label;
    desktopClockToggle.setAttribute("aria-label", label);
    fitDesktopClockText();
}

function updateDesktopClock(now = new Date()) {
    const weekday = document.getElementById("desktop-clock-day");
    weekday.textContent = now.toLocaleDateString([], { weekday: "long" }).toLocaleUpperCase();
    weekday.style.setProperty("--weekday-length", String(weekday.textContent.length));
    document.getElementById("desktop-clock-date").textContent =
        `${String(now.getDate()).padStart(2, "0")} ${now.toLocaleDateString([], { month: "long" }).toLocaleUpperCase()} ${now.getFullYear()}`;
    const time = document.getElementById("desktop-clock-time");
    time.textContent = `– ${now.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hour12: true }).toLocaleUpperCase()} –`;
    time.dateTime = now.toISOString();
    fitDesktopClockText();
}

function saveDesktopClock() {
    const snapshot = { ...desktopClockState };
    desktopClockSave = desktopClockSave
        .then(() => storedSetting("put", "desktopClock", snapshot))
        .catch((error) => {
            settingsStatus.textContent = "The clock changed, but its layout could not be saved.";
            console.warn("Could not save desktop clock:", error);
        });
    return desktopClockSave;
}

async function restoreDesktopClock() {
    try {
        const saved = await storedSetting("get", "desktopClock");
        if (saved && typeof saved === "object") {
            desktopClockState = {
                visible: typeof saved.visible === "boolean" ? saved.visible : true,
                x: Number.isFinite(saved.x) ? saved.x : null,
                y: Number.isFinite(saved.y) ? saved.y : desktopClockDefaults.y,
                width: Number.isFinite(saved.width) ? saved.width : desktopClockDefaults.width,
                height: Number.isFinite(saved.height) ? saved.height : desktopClockDefaults.height,
                color:
                    typeof saved.color === "string" && /^#[\da-f]{6}$/i.test(saved.color)
                        ? saved.color
                        : null
            };
        }
    } catch {
        /* First run and unavailable storage use the upper-right default. */
    }
    renderDesktopClock();
    updateDesktopClock();
    desktopClockToggle.disabled = false;
}

function setDesktopClockVisible(visible) {
    desktopClockState.visible = visible;
    renderDesktopClock();
    if (visible) updateDesktopClock();
    saveDesktopClock();
}

desktopClockToggle.addEventListener("click", () =>
    setDesktopClockVisible(!desktopClockState.visible)
);
document.getElementById("remove-desktop-clock").addEventListener("click", () => {
    setDesktopClockVisible(false);
    homeButton.focus();
});

desktopClock.addEventListener("pointerdown", (event) => {
    if (event.button !== 0) return;
    const resizing = !!event.target.closest("#resize-desktop-clock");
    if (event.target.closest("button") && !resizing) return;
    event.preventDefault();
    desktopClockGesture = {
        pointerId: event.pointerId,
        mode: resizing ? "resize" : "drag",
        pointerX: event.clientX,
        pointerY: event.clientY,
        start: desktopClockLayout(desktopClockState, innerWidth, innerHeight)
    };
    desktopClock.setPointerCapture(event.pointerId);
    desktopClock.classList.add("is-moving");
});
desktopClock.addEventListener("pointermove", (event) => {
    const gesture = desktopClockGesture;
    if (!gesture || event.pointerId !== gesture.pointerId) return;
    const dx = event.clientX - gesture.pointerX;
    const dy = event.clientY - gesture.pointerY;
    const next = { ...desktopClockState, ...gesture.start };
    if (gesture.mode === "resize") {
        next.width += dx;
        next.height += dy;
    } else {
        next.x += dx;
        next.y += dy;
    }
    desktopClockState = { ...next, ...desktopClockLayout(next, innerWidth, innerHeight) };
    renderDesktopClock();
});
function finishDesktopClockGesture(event) {
    if (!desktopClockGesture || event.pointerId !== desktopClockGesture.pointerId) return;
    desktopClockGesture = null;
    desktopClock.classList.remove("is-moving");
    if (desktopClock.hasPointerCapture(event.pointerId))
        desktopClock.releasePointerCapture(event.pointerId);
    saveDesktopClock();
}
desktopClock.addEventListener("pointerup", finishDesktopClockGesture);
desktopClock.addEventListener("pointercancel", finishDesktopClockGesture);
desktopClock.addEventListener("lostpointercapture", finishDesktopClockGesture);

desktopClock.addEventListener("keydown", (event) => {
    const directions = {
        ArrowLeft: [-1, 0],
        ArrowRight: [1, 0],
        ArrowUp: [0, -1],
        ArrowDown: [0, 1]
    };
    const direction = directions[event.key];
    if (!direction || ![desktopClock, desktopClockResize].includes(event.target)) return;
    event.preventDefault();
    const next = {
        ...desktopClockState,
        ...desktopClockLayout(desktopClockState, innerWidth, innerHeight)
    };
    const step = event.shiftKey ? 20 : 10;
    if (event.target === desktopClockResize) {
        next.width += direction[0] * step;
        next.height += direction[1] * step;
    } else {
        next.x += direction[0] * step;
        next.y += direction[1] * step;
    }
    desktopClockState = { ...next, ...desktopClockLayout(next, innerWidth, innerHeight) };
    renderDesktopClock();
    saveDesktopClock();
});
window.addEventListener("resize", renderDesktopClock);

// Clock appearance and context menu
const desktopClockOptions = document.getElementById("desktop-clock-options");
const desktopClockColorPicker = document.getElementById("desktop-clock-color");
let desktopClockTextMetrics = { text: "", width: 0 };

function desktopClockTextSize(measuredWidth, characterCount, width, height) {
    // Include letter spacing when fitting the actual font to the widget's inner width.
    const contentWidth = Math.max(1, width - 14);
    const detailSize = Math.max(10, Math.min(24, (width - 14) * 0.04));
    const availableHeight = Math.max(1, height - 36 - 16 - detailSize * 2.6);
    return Math.max(
        12,
        Math.min(
            (contentWidth * 100) / (measuredWidth + characterCount * 13),
            availableHeight / 1.1
        )
    );
}

function fitDesktopClockText() {
    if (desktopClock.hidden) return;
    const weekday = document.getElementById("desktop-clock-day");
    if (!weekday.textContent) return;
    try {
        if (desktopClockTextMetrics.text !== weekday.textContent) {
            const canvas = document.createElement("canvas");
            const context = canvas.getContext("2d");
            if (!context) return;
            context.font = '100px "Anurati", "Bahnschrift", sans-serif';
            desktopClockTextMetrics = {
                text: weekday.textContent,
                width: context.measureText(weekday.textContent).width
            };
        }
        const layout = desktopClockLayout(desktopClockState, innerWidth, innerHeight);
        const fontSize = desktopClockTextSize(
            desktopClockTextMetrics.width,
            weekday.textContent.length,
            layout.width,
            layout.height
        );
        weekday.style.fontSize = `${fontSize}px`;
    } catch {
        /* CSS keeps text proportional if font measurement is unavailable. */
    }
}

function closeDesktopClockOptions(restoreFocus = false) {
    desktopClockOptions.hidden = true;
    if (restoreFocus && !desktopClock.hidden) desktopClock.focus();
}

desktopClock.addEventListener("contextmenu", (event) => {
    event.preventDefault();
    closeAppOptions();
    setStartMenuOpen(false);
    closeCalendar();
    desktopClockOptions.hidden = false;
    desktopClockOptions.style.left = `${Math.max(8, Math.min(event.clientX, innerWidth - desktopClockOptions.offsetWidth - 8))}px`;
    desktopClockOptions.style.top = `${Math.max(8, Math.min(event.clientY, innerHeight - desktopClockOptions.offsetHeight - 8))}px`;
    document.getElementById("desktop-clock-change-color").focus();
});

document.getElementById("desktop-clock-change-color").addEventListener("click", () => {
    const color = desktopClockState.color || getComputedStyle(desktopClock).color;
    const rgb = color.match(/^rgba?\(\s*(\d+)[, ]+\s*(\d+)[, ]+\s*(\d+)/i);
    desktopClockColorPicker.value = /^#[\da-f]{6}$/i.test(color)
        ? color
        : rgb
          ? `#${rgb
                .slice(1, 4)
                .map((value) => Number(value).toString(16).padStart(2, "0"))
                .join("")}`
          : "#ffffff";
    closeDesktopClockOptions();
    desktopClockColorPicker.click();
});
desktopClockColorPicker.addEventListener("input", () => {
    desktopClockState.color = desktopClockColorPicker.value;
    renderDesktopClock();
});
desktopClockColorPicker.addEventListener("change", () => {
    desktopClockState.color = desktopClockColorPicker.value;
    renderDesktopClock();
    saveDesktopClock();
});

document.getElementById("desktop-clock-reset").addEventListener("click", () => {
    desktopClockState = { ...desktopClockDefaults };
    closeDesktopClockOptions();
    renderDesktopClock();
    updateDesktopClock();
    saveDesktopClock();
});
document.getElementById("desktop-clock-menu-remove").addEventListener("click", () => {
    closeDesktopClockOptions();
    setDesktopClockVisible(false);
    homeButton.focus();
});
document.addEventListener("pointerdown", (event) => {
    if (!desktopClockOptions.contains(event.target)) closeDesktopClockOptions();
});
desktopClockOptions.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
        event.preventDefault();
        closeDesktopClockOptions(true);
    }
    if (event.key === "Tab") closeDesktopClockOptions();
    if (["ArrowUp", "ArrowDown"].includes(event.key)) {
        event.preventDefault();
        const buttons = [...desktopClockOptions.querySelectorAll("button")];
        const step = event.key === "ArrowDown" ? 1 : -1;
        const index = buttons.indexOf(document.activeElement);
        buttons[(index + step + buttons.length) % buttons.length].focus();
    }
});
window.addEventListener("resize", () => closeDesktopClockOptions());
window.addEventListener("blur", () => closeDesktopClockOptions());
if (document.fonts) {
    document.fonts
        .load('100px "Anurati"')
        .then(() => {
            desktopClockTextMetrics = { text: "", width: 0 };
            fitDesktopClockText();
        })
        .catch(() => {});
}

// Startup: restore saved state before revealing the desktop.
updateClock();
setInterval(updateClock, 1000);
const restoreWallpaperReady = restoreWallpaper();
const restoreProfileReady = restoreProfile();
const restoreAppViewReady = restoreAppView();
const initializeAppsReady = initializeApps();
const restoreThemeReady = restoreTheme();
const restoreMusicReady = restoreMusic();
const restoreDesktopClockReady = restoreDesktopClock();
revealDesktop();
