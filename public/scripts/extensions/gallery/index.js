import {
    eventSource,
    this_chid,
    characters,
    getRequestHeaders,
    event_types,
    animation_duration,
    animation_easing,
} from '../../../script.js';
import { groups, selected_group } from '../../group-chats.js';
import { loadFileToDocument, delay, getBase64Async, getSanitizedFilename, saveBase64AsFile, getFileExtension, getVideoThumbnail, clamp } from '../../utils.js';
import { loadMovingUIState } from '../../power-user.js';
import { dragElement } from '../../RossAscends-mods.js';
import { SlashCommandParser } from '../../slash-commands/SlashCommandParser.js';
import { SlashCommand } from '../../slash-commands/SlashCommand.js';
import { ARGUMENT_TYPE, SlashCommandNamedArgument } from '../../slash-commands/SlashCommandArgument.js';
import { DragAndDropHandler } from '../../dragdrop.js';
import { commonEnumProviders } from '../../slash-commands/SlashCommandCommonEnumsProvider.js';
import { t, translate } from '../../i18n.js';
import { Popup } from '../../popup.js';
import { deleteMediaFromServer } from '../../chats.js';
import { MEDIA_REQUEST_TYPE, VIDEO_EXTENSIONS } from '../../constants.js';

const isVideo = (/** @type {string} */ url) => VIDEO_EXTENSIONS.some(ext => new RegExp(`.${ext}$`, 'i').test(url));
const extensionName = 'gallery';
const extensionFolderPath = `scripts/extensions/${extensionName}/`;
let firstTime = true;
let deleteModeActive = false;

// ─── Lightbox State ───────────────────────────────────────────────────────────
let lightbox = null;
let lbScale = 1;
let lbPanX = 0;
let lbPanY = 0;
let lbIsDragging = false;
let lbLastX = 0;
let lbLastY = 0;
let lbLastPinchDist = 0;
let lbNaturalW = 0;   // natural image dimensions, set after load
let lbNaturalH = 0;
// ─────────────────────────────────────────────────────────────────────────────

// Tag Mode global
let tagModeActive = false;

// Remove all draggables associated with the gallery
$('#movingDivs').on('click', '.dragClose', function () {
    const relatedId = $(this).data('related-id');
    if (!relatedId) return;
    const relatedElement = $(`#movingDivs > .draggable[id="${relatedId}"]`);
    relatedElement.transition({
        opacity: 0,
        duration: animation_duration,
        easing: animation_easing,
        complete: () => {
            relatedElement.remove();
        },
    });
});

const CUSTOM_GALLERY_REMOVED_EVENT = 'galleryRemoved';

const mutationObserver = new MutationObserver((mutations) => {
    mutations.forEach((mutation) => {
        mutation.removedNodes.forEach((node) => {
            if (node instanceof HTMLElement && node.tagName === 'DIV' && node.id === 'gallery') {
                eventSource.emit(CUSTOM_GALLERY_REMOVED_EVENT);
            }
        });
    });
});

mutationObserver.observe(document.body, {
    childList: true,
    subtree: false,
});

const SORT = Object.freeze({
    NAME_ASC: { value: 'nameAsc', field: 'name', order: 'asc', label: t`Name (A-Z)` },
    NAME_DESC: { value: 'nameDesc', field: 'name', order: 'desc', label: t`Name (Z-A)` },
    DATE_DESC: { value: 'dateDesc', field: 'date', order: 'desc', label: t`Newest` },
    DATE_ASC: { value: 'dateAsc', field: 'date', order: 'asc', label: t`Oldest` },
});

const defaultSettings = Object.freeze({
    folders: {},
    sort: SORT.DATE_ASC.value,
    imageTags: {},       // { [avatarKey]: { [filename]: string[] } }
    activeTagFilter: {}, // { [avatarKey]: string | null }
});

// ─── Settings helpers ─────────────────────────────────────────────────────────

function initSettings() {
    let shouldSave = false;
    const context = SillyTavern.getContext();
    if (!context.extensionSettings.gallery) {
        context.extensionSettings.gallery = structuredClone(defaultSettings);
        shouldSave = true;
    }
    for (const key of Object.keys(defaultSettings)) {
        if (!Object.hasOwn(context.extensionSettings.gallery, key)) {
            context.extensionSettings.gallery[key] = structuredClone(defaultSettings[key]);
            shouldSave = true;
        }
    }
    if (shouldSave) {
        context.saveSettingsDebounced();
    }
}

function getGalleryFolder(char) {
    return SillyTavern.getContext().extensionSettings.gallery.folders[char?.avatar] ?? char?.name;
}

/** Get the avatar key for the current char/group. */
function getCurrentAvatarKey() {
    if (selected_group) return `group:${selected_group}`;
    if (this_chid !== undefined) return characters[this_chid]?.avatar ?? String(this_chid);
    return '__unknown__';
}

/** Return all tags used by this avatar. */
function getTagsForAvatar(avatarKey) {
    const ctx = SillyTavern.getContext();
    const map = ctx.extensionSettings.gallery.imageTags[avatarKey] ?? {};
    const set = new Set();
    Object.values(map).forEach(tags => tags.forEach(t => set.add(t)));
    return [...set].sort();
}

/** Return tags for a specific filename. */
function getTagsForFile(avatarKey, filename) {
    const ctx = SillyTavern.getContext();
    return ctx.extensionSettings.gallery.imageTags[avatarKey]?.[filename] ?? [];
}

/** Set tags for a specific filename. */
function setTagsForFile(avatarKey, filename, tags) {
    const ctx = SillyTavern.getContext();
    if (!ctx.extensionSettings.gallery.imageTags[avatarKey]) {
        ctx.extensionSettings.gallery.imageTags[avatarKey] = {};
    }
    if (tags.length === 0) {
        delete ctx.extensionSettings.gallery.imageTags[avatarKey][filename];
    } else {
        ctx.extensionSettings.gallery.imageTags[avatarKey][filename] = tags;
    }
    ctx.saveSettingsDebounced();
}

function getActiveTagFilter(avatarKey) {
    return SillyTavern.getContext().extensionSettings.gallery.activeTagFilter[avatarKey] ?? null;
}

function setActiveTagFilter(avatarKey, tag) {
    const ctx = SillyTavern.getContext();
    if (!ctx.extensionSettings.gallery.activeTagFilter) {
        ctx.extensionSettings.gallery.activeTagFilter = {};
    }
    ctx.extensionSettings.gallery.activeTagFilter[avatarKey] = tag;
    ctx.saveSettingsDebounced();
}

// ─── API helpers ──────────────────────────────────────────────────────────────

async function getGalleryItems(url) {
    const sortValue = getSortOrder();
    const sortObj = Object.values(SORT).find(it => it.value === sortValue) ?? SORT.DATE_ASC;
    const response = await fetch('/api/images/list', {
        method: 'POST',
        headers: getRequestHeaders(),
        body: JSON.stringify({
            folder: url,
            sortField: sortObj.field,
            sortOrder: sortObj.order,
            type: MEDIA_REQUEST_TYPE.IMAGE | MEDIA_REQUEST_TYPE.VIDEO,
        }),
    });

    url = await getSanitizedFilename(url);
    const data = await response.json();
    const items = [];

    for (const file of data) {
        const item = {
            src: `user/images/${url}/${file}`,
            srct: `user/images/${url}/${file}`,
            title: '',
            filename: file,
        };

        if (isVideo(file)) {
            try {
                const maxSide = Math.round(150 * 1.5);
                item.srct = await getVideoThumbnail(item.src, maxSide, maxSide);
            } catch (error) {
                console.error('Failed to generate video thumbnail for gallery:', error);
            }
        }

        items.push(item);
    }

    return items;
}

async function getGalleryFolders() {
    try {
        const response = await fetch('/api/images/folders', {
            method: 'POST',
            headers: getRequestHeaders({ omitContentType: true }),
        });
        if (!response.ok) throw new Error(`HTTP error. Status: ${response.status}`);
        return await response.json();
    } catch (error) {
        console.error('Failed to fetch gallery folders:', error);
        return [];
    }
}

async function deleteGalleryItem(url) {
    const isDeleted = await deleteMediaFromServer(url, false);
    if (isDeleted) toastr.success(t`Image deleted successfully.`);
}

function setSortOrder(order) {
    const context = SillyTavern.getContext();
    context.extensionSettings.gallery.sort = order;
    context.saveSettingsDebounced();
}

function getSortOrder() {
    return SillyTavern.getContext().extensionSettings.gallery.sort ?? defaultSettings.sort;
}

// ─── Lightbox ─────────────────────────────────────────────────────────────────

/**
 * Opens a centered, contained lightbox with pan/zoom.
 * Uses the contained-box model: image is position:absolute inside a bounded
 * overflow:hidden area, so it can never escape the container.
 * Pan is clamped to the image edges — you can only pan to revealed content.
 * @param {string} url
 */
function openLightbox(url) {
    closeLightbox();

    lbScale = 1;
    lbPanX = 0;
    lbPanY = 0;
    lbNaturalW = 0;
    lbNaturalH = 0;

    // ── Outer overlay (full viewport backdrop) ──
    const overlay = document.createElement('div');
    overlay.id = 'gallery-lightbox';
    overlay.classList.add('gallery-lightbox-overlay');

    // ── Centered container card ──
    const container = document.createElement('div');
    container.classList.add('gallery-lb-container');

    // ── Close button — inside container, position absolute top-right (same pattern as bg extension) ──
    const closeBtn = document.createElement('button');
    closeBtn.classList.add('gallery-lb-close-btn');
    closeBtn.innerHTML = '<i class="fa-solid fa-xmark"></i>';
    closeBtn.title = t`Close`;
    closeBtn.addEventListener('click', (e) => { e.stopPropagation(); closeLightbox(); });

    // ── Scroll/pan area ──
    const scrollArea = document.createElement('div');
    scrollArea.classList.add('gallery-lb-scroll-area');

    // ── Media element ──
    let mediaEl;
    if (isVideo(url)) {
        mediaEl = document.createElement('video');
        mediaEl.src = url;
        mediaEl.controls = true;
        mediaEl.autoplay = true;
        mediaEl.classList.add('gallery-lb-media');
        // Videos aren't panned the same way; pointer-events needed for controls
        mediaEl.style.pointerEvents = 'auto';
    } else {
        mediaEl = document.createElement('img');
        mediaEl.src = url;
        mediaEl.classList.add('gallery-lb-media');
        mediaEl.draggable = false;
        // Record natural dimensions when loaded so we can clamp correctly
        mediaEl.addEventListener('load', () => {
            lbNaturalW = mediaEl.naturalWidth;
            lbNaturalH = mediaEl.naturalHeight;
        });
    }
    scrollArea.appendChild(mediaEl);

    // ── Zoom controls bar ──
    const zoomBar = document.createElement('div');
    zoomBar.classList.add('gallery-lb-zoom-bar');

    const zoomOutBtn = makeLbBarBtn('−', t`Zoom out`, () => applyLbZoom(lbScale * 0.8, scrollArea));
    const zoomLabel  = document.createElement('span');
    zoomLabel.classList.add('gallery-lb-zoom-label');
    zoomLabel.textContent = '100%';
    const zoomInBtn  = makeLbBarBtn('+', t`Zoom in`,  () => applyLbZoom(lbScale * 1.25, scrollArea));
    const resetBtn   = makeLbBarBtn('<i class="fa-solid fa-compress"></i>', t`Reset`, () => resetLbTransform(scrollArea, zoomLabel));
    const tagBtn = makeLbBarBtn('<i class="fa-solid fa-tag"></i>', t`Edit tags`, () => {
        // On mobile the software keyboard squashes dvh, hiding a panel inside the
        // container. Spawn it as a fixed overlay on <html> instead, centered in
        // the lower-half of the screen so the keyboard doesn't cover it.
        const isMobile = window.innerWidth <= 600;
        if (isMobile) {
            document.querySelectorAll('.gallery-tag-popover').forEach(p => p.remove());
            const floatingPanel = document.createElement('div');
            floatingPanel.classList.add('gallery-tag-popover');
            floatingPanel.style.cssText = `
                position: fixed;
                z-index: 1000002;
                left: 50%;
                transform: translateX(-50%);
                top: 10px;
                width: calc(100vw - 24px);
                max-width: 400px;
            `;
            document.documentElement.appendChild(floatingPanel);
            openTagEditor(url, floatingPanel, () => floatingPanel.remove());
        } else {
            openTagEditor(url, container);
        }
    });

    zoomBar.append(zoomOutBtn, zoomLabel, zoomInBtn, resetBtn);

    // Desktop-only: open the full-res image in a new browser tab.
    // Hidden on mobile since tapping a new-tab link there is a poor UX
    // (it just re-opens the same image full screen in another tab).
    if (window.innerWidth > 600) {
        const openTabBtn = makeLbBarBtn('<i class="fa-solid fa-arrow-up-right-from-square"></i>', t`Open in new tab`, () => {
            window.open(url, '_blank', 'noopener,noreferrer');
        });
        zoomBar.append(openTabBtn);
    }

    zoomBar.append(tagBtn);

    // ── Hint line ──
    const hint = document.createElement('div');
    hint.classList.add('gallery-lb-hint');
    hint.textContent = t`Scroll or pinch to zoom · Drag to pan`;

    container.append(closeBtn, scrollArea, zoomBar, hint);
    overlay.appendChild(container);
    // Append to <html> (not <body>) so that fixed positioning is always relative
    // to the true viewport — avoids clipping on mobile when SillyTavern applies
    // CSS transforms / will-change to <body> for its sliding UI panels.
    overlay.style.width  = `${window.innerWidth}px`;
    overlay.style.height = `${window.innerHeight}px`;
    document.documentElement.appendChild(overlay);
    lightbox = overlay;

    requestAnimationFrame(() => overlay.classList.add('gallery-lightbox-visible'));

    // Close when clicking the dark backdrop (outside the container)
    overlay.addEventListener('click', (e) => {
        if (e.target === overlay) closeLightbox();
    });

    // ── Mouse wheel zoom ──
    scrollArea.addEventListener('wheel', (e) => {
        e.preventDefault();
        const delta = e.deltaY < 0 ? 1.12 : 0.88;
        applyLbZoom(lbScale * delta, scrollArea, zoomLabel);
    }, { passive: false });

    // ── Mouse drag pan ──
    scrollArea.addEventListener('mousedown', (e) => {
        if (e.button !== 0) return;
        lbIsDragging = true;
        lbLastX = e.clientX;
        lbLastY = e.clientY;
        scrollArea.classList.add('gallery-lb-dragging');
        e.preventDefault();
    });

    function lbMouseMove(e) {
        if (!lbIsDragging) return;
        lbPanX += e.clientX - lbLastX;
        lbPanY += e.clientY - lbLastY;
        lbLastX = e.clientX;
        lbLastY = e.clientY;
        applyLbTransform(scrollArea, zoomLabel);
    }

    function lbMouseUp() {
        if (!lbIsDragging) return;
        lbIsDragging = false;
        scrollArea.classList.remove('gallery-lb-dragging');
    }

    window.addEventListener('mousemove', lbMouseMove);
    window.addEventListener('mouseup', lbMouseUp);

    // ── Touch: drag + pinch ──
    scrollArea.addEventListener('touchstart', lbTouchStart, { passive: false });
    scrollArea.addEventListener('touchmove', lbTouchMove, { passive: false });
    scrollArea.addEventListener('touchend', lbTouchEnd, { passive: false });

    function lbTouchStart(e) {
        if (e.touches.length === 2) {
            lbLastPinchDist = Math.hypot(
                e.touches[0].clientX - e.touches[1].clientX,
                e.touches[0].clientY - e.touches[1].clientY,
            );
            lbIsDragging = false;
        } else if (e.touches.length === 1) {
            lbIsDragging = true;
            lbLastX = e.touches[0].clientX;
            lbLastY = e.touches[0].clientY;
        }
        e.preventDefault();
    }

    function lbTouchMove(e) {
        e.preventDefault();
        if (e.touches.length === 2) {
            lbIsDragging = false;
            const dist = Math.hypot(
                e.touches[0].clientX - e.touches[1].clientX,
                e.touches[0].clientY - e.touches[1].clientY,
            );
            if (lbLastPinchDist > 0) {
                applyLbZoom(lbScale * (dist / lbLastPinchDist), scrollArea, zoomLabel);
            }
            lbLastPinchDist = dist;
        } else if (e.touches.length === 1 && lbIsDragging) {
            lbPanX += e.touches[0].clientX - lbLastX;
            lbPanY += e.touches[0].clientY - lbLastY;
            lbLastX = e.touches[0].clientX;
            lbLastY = e.touches[0].clientY;
            applyLbTransform(scrollArea, zoomLabel);
        }
    }

    function lbTouchEnd() {
        lbIsDragging = false;
        lbLastPinchDist = 0;
    }

    // Keyboard shortcuts
    overlay.setAttribute('tabindex', '-1');
    overlay.focus();
    overlay.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') closeLightbox();
        if (e.key === '+' || e.key === '=') applyLbZoom(lbScale * 1.2, scrollArea, zoomLabel);
        if (e.key === '-') applyLbZoom(lbScale * 0.8, scrollArea, zoomLabel);
        if (e.key === '0') resetLbTransform(scrollArea, zoomLabel);
    });

    // Cleanup listeners when lightbox is removed
    const origClose = closeLightbox;
    overlay._cleanup = () => {
        window.removeEventListener('mousemove', lbMouseMove);
        window.removeEventListener('mouseup', lbMouseUp);
    };
}

/**
 * Compute the maximum pan offset so the image edge never goes past the
 * scroll-area edge. When scale <= 1, pan is locked to 0.
 * @param {HTMLElement} scrollArea
 * @returns {{ maxX: number, maxY: number }}
 */
function getLbPanLimits(scrollArea) {
    const areaW = scrollArea.clientWidth;
    const areaH = scrollArea.clientHeight;
    const mediaEl = scrollArea.querySelector('.gallery-lb-media');
    if (!mediaEl) return { maxX: 0, maxY: 0 };

    // The rendered (unscaled) size of the image inside the area
    const renderedW = mediaEl.offsetWidth;
    const renderedH = mediaEl.offsetHeight;

    // At scale 1 the image fits inside the area (object-fit:contain equivalent),
    // so the pannable range is the overflow introduced by zooming.
    const scaledW = renderedW * lbScale;
    const scaledH = renderedH * lbScale;

    const maxX = Math.max(0, (scaledW - areaW) / 2);
    const maxY = Math.max(0, (scaledH - areaH) / 2);
    return { maxX, maxY };
}

function applyLbZoom(newScale, scrollArea, zoomLabel) {
    lbScale = clamp(newScale, 0.5, 20);
    // Re-clamp pan after scale change
    const { maxX, maxY } = getLbPanLimits(scrollArea);
    lbPanX = clamp(lbPanX, -maxX, maxX);
    lbPanY = clamp(lbPanY, -maxY, maxY);
    applyLbTransform(scrollArea, zoomLabel);
}

function applyLbTransform(scrollArea, zoomLabel) {
    // Clamp pan first
    const { maxX, maxY } = getLbPanLimits(scrollArea);
    lbPanX = clamp(lbPanX, -maxX, maxX);
    lbPanY = clamp(lbPanY, -maxY, maxY);

    const mediaEl = scrollArea.querySelector('.gallery-lb-media');
    if (mediaEl) {
        // Position absolute, centered at 50%/50%, then offset by pan+scale
        mediaEl.style.transform = `translate(calc(-50% + ${lbPanX}px), calc(-50% + ${lbPanY}px)) scale(${lbScale})`;
    }
    if (zoomLabel) {
        zoomLabel.textContent = `${Math.round(lbScale * 100)}%`;
    }
}

function resetLbTransform(scrollArea, zoomLabel) {
    lbScale = 1;
    lbPanX = 0;
    lbPanY = 0;
    applyLbTransform(scrollArea, zoomLabel);
}

function closeLightbox() {
    if (!lightbox) return;
    if (typeof lightbox._cleanup === 'function') lightbox._cleanup();
    lightbox.classList.remove('gallery-lightbox-visible');
    const el = lightbox;
    lightbox = null;
    setTimeout(() => el.remove(), 200);
}

function makeLbBarBtn(htmlContent, titleStr, onClick) {
    const btn = document.createElement('button');
    btn.classList.add('gallery-lb-zoom-btn');
    btn.title = titleStr;
    btn.innerHTML = htmlContent;
    btn.addEventListener('click', (e) => { e.stopPropagation(); onClick(); });
    return btn;
}

// ─── Tag editor (opens inside lightbox container) ────────────────────────────

/**
 * Opens an inline tag editor panel anchored to the given parent element.
 * Used both by the lightbox and the bulk-tag mode.
 * @param {string} url  full image URL (used to derive filename)
 * @param {HTMLElement} parentEl  element to append the panel to
 * @param {Function} [onClose]  optional callback when panel is dismissed
 */
function openTagEditor(url, parentEl, onClose) {
    const avatarKey = getCurrentAvatarKey();
    const filename = url.split('/').pop();
    let allTags = getTagsForAvatar(avatarKey);

    // Remove existing panel if present in same parent
    parentEl.querySelector('.gallery-tag-editor')?.remove();

    const panel = document.createElement('div');
    panel.classList.add('gallery-tag-editor');

    const titleRow = document.createElement('div');
    titleRow.classList.add('gallery-tag-editor-titlerow');

    const title = document.createElement('div');
    title.classList.add('gallery-tag-editor-title');
    title.textContent = t`Tags`;

    const closeEditorBtn = document.createElement('button');
    closeEditorBtn.classList.add('gallery-tag-editor-close');
    closeEditorBtn.innerHTML = '×';
    closeEditorBtn.title = t`Close`;
    closeEditorBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        panel.remove();
        if (onClose) onClose();
    });

    titleRow.append(title, closeEditorBtn);

    const tagList = document.createElement('div');
    tagList.classList.add('gallery-tag-list');

    const renderTags = (tags) => {
        tagList.innerHTML = '';
        if (tags.length === 0) {
            const empty = document.createElement('span');
            empty.classList.add('gallery-tag-empty');
            empty.textContent = t`No tags yet`;
            tagList.appendChild(empty);
            return;
        }
        tags.forEach(tag => {
            const chip = document.createElement('span');
            chip.classList.add('gallery-tag-chip');
            chip.textContent = tag;
            const removeBtn = document.createElement('button');
            removeBtn.classList.add('gallery-tag-chip-remove');
            removeBtn.innerHTML = '×';
            removeBtn.title = t`Remove tag`;
            removeBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                const updated = getTagsForFile(avatarKey, filename).filter(t => t !== tag);
                setTagsForFile(avatarKey, filename, updated);
                renderTags(updated);
                refreshTagFilterUI();
                updateThumbBadge(filename);
            });
            chip.appendChild(removeBtn);
            tagList.appendChild(chip);
        });
    };
    renderTags(getTagsForFile(avatarKey, filename));

    const inputRow = document.createElement('div');
    inputRow.classList.add('gallery-tag-input-row');

    const input = document.createElement('input');
    input.type = 'text';
    input.classList.add('gallery-tag-input', 'text_pole');
    input.placeholder = t`Add tag…`;

    // Refresh allTags when we open the autocomplete to pick up newly-created tags
    $(input).autocomplete({
        source: (req, res) => {
            allTags = getTagsForAvatar(avatarKey);
            const term = req.term.toLowerCase();
            res(allTags.filter(t => t.toLowerCase().includes(term) && !getTagsForFile(avatarKey, filename).includes(t)));
        },
        minLength: 0,
    }).on('focus', () => $(input).autocomplete('search', ''));

    const addTagBtn = document.createElement('button');
    addTagBtn.classList.add('gallery-lb-zoom-btn');
    addTagBtn.innerHTML = '<i class="fa-solid fa-plus"></i>';
    addTagBtn.title = t`Add tag`;

    const doAddTag = () => {
        const val = input.value.trim().toLowerCase().replace(/[^a-z0-9_\-\s]/g, '').replace(/\s+/g, '_');
        if (!val) return;
        const existing = getTagsForFile(avatarKey, filename);
        if (!existing.includes(val)) {
            const updated = [...existing, val];
            setTagsForFile(avatarKey, filename, updated);
            renderTags(updated);
            refreshTagFilterUI();
            updateThumbBadge(filename);
        }
        input.value = '';
        $(input).autocomplete('close');
    };
    addTagBtn.addEventListener('click', (e) => { e.stopPropagation(); doAddTag(); });
    input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') { e.preventDefault(); e.stopPropagation(); doAddTag(); }
    });

    inputRow.append(input, addTagBtn);
    panel.append(titleRow, tagList, inputRow);
    parentEl.appendChild(panel);

    input.focus();
}

/**
 * Updates the tag badge on a nanogallery thumbnail (if visible).
 * @param {string} filename
 */
function updateThumbBadge(filename) {
    const avatarKey = getCurrentAvatarKey();
    const tags = getTagsForFile(avatarKey, filename);
    // Find the thumbnail by title attribute
    const thumb = document.querySelector(`#dragGallery [title="${filename}"]`);
    if (!thumb) return;
    let badge = thumb.querySelector('.gallery-thumb-tag-badge');
    if (tags.length === 0) {
        badge?.remove();
    } else {
        if (!badge) {
            badge = document.createElement('div');
            badge.classList.add('gallery-thumb-tag-badge');
            thumb.appendChild(badge);
        }
        badge.innerHTML = `<i class="fa-solid fa-tag"></i> ${tags.length}`;
        badge.title = tags.join(', ');
    }
}

/** Refreshes the tag strip in the gallery panel if it's open. */
function refreshTagFilterUI() {
    const strip = document.getElementById('gallery-tag-filter-strip');
    if (strip) buildTagFilterStrip(strip);
}

function buildTagFilterStrip(strip) {
    const avatarKey = getCurrentAvatarKey();
    const allTags = getTagsForAvatar(avatarKey);
    const active = getActiveTagFilter(avatarKey);

    strip.innerHTML = '';
    if (allTags.length === 0) {
        strip.style.display = 'none';
        return;
    }
    strip.style.display = 'flex';

    const allChip = document.createElement('button');
    allChip.classList.add('gallery-filter-chip');
    if (!active) allChip.classList.add('active');
    allChip.textContent = t`All`;
    allChip.addEventListener('click', async () => {
        setActiveTagFilter(avatarKey, null);
        await reloadGalleryItems();
    });
    strip.appendChild(allChip);

    allTags.forEach(tag => {
        const chip = document.createElement('button');
        chip.classList.add('gallery-filter-chip');
        if (active === tag) chip.classList.add('active');
        chip.textContent = tag;
        chip.addEventListener('click', async () => {
            setActiveTagFilter(avatarKey, tag);
            await reloadGalleryItems();
        });
        strip.appendChild(chip);
    });
}

// ─── Gallery reload helper (re-fetch items and reinit, keeping panel open) ───

let _currentGalleryUrl = null;

async function reloadGalleryItems() {
    if (!_currentGalleryUrl) return;
    const avatarKey = getCurrentAvatarKey();
    const activeTag = getActiveTagFilter(avatarKey);
    let items = await getGalleryItems(_currentGalleryUrl);

    if (activeTag) {
        items = items.filter(item => {
            const fn = item.filename;
            const tags = getTagsForFile(avatarKey, fn);
            return tags.includes(activeTag);
        });
    }

    // Destroy and re-init nanogallery in place
    const gallery = $('#dragGallery');
    try { gallery.nanogallery2('destroy'); } catch (_) { /* ignore */ }
    gallery.empty();
    await initNanogallery(items, _currentGalleryUrl);

    // Rebuild the strip so the active chip reflects the new selection
    refreshTagFilterUI();
}

// ─── Gallery init ─────────────────────────────────────────────────────────────

async function initGallery(items, url) {
    _currentGalleryUrl = url;

    // Build tag filter strip above gallery
    let strip = document.getElementById('gallery-tag-filter-strip');
    if (!strip) {
        strip = document.createElement('div');
        strip.id = 'gallery-tag-filter-strip';
        strip.classList.add('gallery-tag-filter-strip');
        const dragGallery = document.getElementById('dragGallery');
        dragGallery?.parentElement?.insertBefore(strip, dragGallery);
    }
    buildTagFilterStrip(strip);

    // Filter items by active tag
    const avatarKey = getCurrentAvatarKey();
    const activeTag = getActiveTagFilter(avatarKey);
    let filteredItems = items;
    if (activeTag) {
        filteredItems = items.filter(item => {
            const tags = getTagsForFile(avatarKey, item.filename);
            return tags.includes(activeTag);
        });
    }

    await initNanogallery(filteredItems, url);
}

async function initNanogallery(items, url) {
    const thumbnailHeight = 150;
    const paginationVisiblePages = 5;
    const paginationMaxLinesPerPage = 2;
    const galleryMaxRows = clamp(Math.floor((window.innerHeight * 0.9 - 75) / thumbnailHeight), 1, 10);

    const nonce = `nonce-${Math.random().toString(36).substring(2, 15)}`;
    const gallery = $('#dragGallery');
    gallery.addClass(nonce);

    gallery.nanogallery2({
        'items': items,
        thumbnailWidth: 'auto',
        thumbnailHeight: thumbnailHeight,
        paginationVisiblePages: paginationVisiblePages,
        paginationMaxLinesPerPage: paginationMaxLinesPerPage,
        galleryMaxRows: galleryMaxRows,
        galleryPaginationTopButtons: false,
        galleryNavigationOverlayButtons: true,
        galleryPaginationMode: 'numbers',
        galleryTheme: {
            navigationBar: { background: 'none', borderTop: '', borderBottom: '', borderRight: '', borderLeft: '' },
            navigationBreadcrumb: { background: 'var(--black30a)', color: 'var(--SmartThemeBodyColor)', colorHover: '#fff', borderRadius: '999px' },
            navigationFilter: { color: 'var(--SmartThemeBodyColor)', background: 'var(--black30a)', colorSelected: '#fff', backgroundSelected: 'var(--SmartThemeQuoteColor)', borderRadius: '999px' },
            navigationPagination: { background: 'var(--black30a)', color: 'var(--SmartThemeBodyColor)', colorHover: '#fff', borderRadius: '999px' },
            thumbnail: {
                background: 'var(--black30a)',
                backgroundImage: 'none',
                borderColor: 'rgba(255,255,255,0.08)',
                borderRadius: '10px',
                labelOpacity: 1,
                labelBackground: 'rgba(0,0,0,0)',
                titleColor: '#fff',
                titleBgColor: 'transparent',
                titleShadow: '',
                descriptionColor: '#ccc',
                descriptionBgColor: 'transparent',
                descriptionShadow: '',
                stackBackground: 'var(--black30a)',
            },
            thumbnailIcon: { padding: '5px', color: '#fff', shadow: '' },
            pagination: {
                background: 'var(--black30a)',
                backgroundSelected: 'var(--SmartThemeQuoteColor)',
                color: 'var(--SmartThemeBodyColor)',
                borderRadius: '999px',
                shapeBorder: '1px solid rgba(255,255,255,0.12)',
                shapeColor: 'var(--black30a)',
                shapeSelectedColor: 'var(--SmartThemeQuoteColor)',
            },
        },
        galleryDisplayMode: 'pagination',
        fnThumbnailOpen: viewWithLightbox,
        fnThumbnailInit: function (/** @type {JQuery<HTMLElement>} */ $thumbnail, /** @type {{src: string, filename: string}} */ item) {
            if (!item?.src) return;
            $thumbnail.attr('title', item.filename || String(item.src).split('/').pop());

            // Show tag badge if the image has tags
            const avatarKey = getCurrentAvatarKey();
            const fn = item.filename || String(item.src).split('/').pop();
            const tags = getTagsForFile(avatarKey, fn);
            if (tags.length > 0) {
                const badge = document.createElement('div');
                badge.classList.add('gallery-thumb-tag-badge');
                badge.innerHTML = `<i class="fa-solid fa-tag"></i> ${tags.length}`;
                badge.title = tags.join(', ');
                $thumbnail[0].appendChild(badge);
            }
        },
    });

    const dragDropHandler = new DragAndDropHandler(`#dragGallery.${nonce}`, async (files) => {
        if (!Array.isArray(files) || files.length === 0) return;
        for (const file of files) {
            await uploadFile(file, url);
        }
        const newItems = await getGalleryItems(url);
        $('#dragGallery').closest('#gallery').remove();
        await makeMovable(url);
        await delay(100);
        await initGallery(newItems, url);
    });

    const resizeHandler = function () { gallery.nanogallery2('resize'); };
    eventSource.on('resizeUI', resizeHandler);

    eventSource.once(event_types.CHAT_CHANGED, function () {
        gallery.closest('#gallery').remove();
    });

    eventSource.once(CUSTOM_GALLERY_REMOVED_EVENT, function () {
        gallery.nanogallery2('destroy');
        dragDropHandler.destroy();
        eventSource.removeListener('resizeUI', resizeHandler);
        closeLightbox();
        tagModeActive = false;
        document.querySelectorAll('.gallery-tag-popover').forEach(p => p.remove());
    });

    gallery.css('height', gallery.parent().css('height'));
    await delay(100);
    gallery.css('height', 'unset');
    gallery.nanogallery2('resize');
}

// ─── Lightbox / Tag-mode open handler ────────────────────────────────────────

function viewWithLightbox(items) {
    if (!items || items.length === 0) return;
    const url = items[0].responsiveURL();

    if (deleteModeActive) {
        Popup.show.confirm(t`Are you sure you want to delete this image?`, url)
            .then(async (confirmed) => {
                if (!confirmed) return;
                await deleteGalleryItem(url);
                showCharGallery(deleteModeActive);
            });
    } else if (tagModeActive) {
        // In tag mode: show a floating tag editor in a single fixed location.
        // Desktop: anchored just below the gallery panel header.
        // Mobile (≤600px): centered on screen.
        // Close any existing popovers first.
        document.querySelectorAll('.gallery-tag-popover').forEach(p => p.remove());

        const editorPanel = document.createElement('div');
        editorPanel.classList.add('gallery-tag-popover');
        editorPanel.style.position = 'fixed';
        editorPanel.style.zIndex = '99999';

        const isMobile = window.innerWidth <= 600;
        if (isMobile) {
            // Use visualViewport if available — it reflects the actual visible area
            // after the software keyboard appears, preventing the panel from hiding behind it.
            // We pin it near the top of the screen so the keyboard never covers it.
            const vvTop    = window.visualViewport?.offsetTop  ?? 0;
            const vvLeft   = window.visualViewport?.offsetLeft ?? 0;
            const vvWidth  = window.visualViewport?.width      ?? window.innerWidth;
            const panelW   = Math.min(vvWidth - 24, 400);
            editorPanel.style.top       = `${vvTop + 10}px`;
            editorPanel.style.left      = `${vvLeft + (vvWidth - panelW) / 2}px`;
            editorPanel.style.width     = `${panelW}px`;
            editorPanel.style.transform = 'none';
        } else {
            // Anchor below the gallery panel header (top-left of gallery panel + header height offset)
            const galleryEl = document.getElementById('gallery');
            if (galleryEl) {
                const galleryRect = galleryEl.getBoundingClientRect();
                const headerEl = galleryEl.querySelector('.gallery-panel-header');
                const headerH = headerEl ? headerEl.getBoundingClientRect().height : 40;
                // Place below the header, aligned to the left edge of the panel
                const panelW = 280;
                let left = galleryRect.left;
                let top  = galleryRect.top + headerH + 8;
                // Clamp so it doesn't overflow the viewport
                left = Math.max(8, Math.min(left, window.innerWidth - panelW - 8));
                top  = Math.max(8, Math.min(top,  window.innerHeight - 260));
                editorPanel.style.left = `${left}px`;
                editorPanel.style.top  = `${top}px`;
                editorPanel.style.transform = 'none';
            } else {
                // Fallback: top-left safe zone
                editorPanel.style.left = '20px';
                editorPanel.style.top  = '80px';
                editorPanel.style.transform = 'none';
            }
        }

        // Append to <html> not <body> — avoids fixed-position breakage from body transforms on mobile
        document.documentElement.appendChild(editorPanel);
        openTagEditor(url, editorPanel, () => editorPanel.remove());
    } else {
        openLightbox(url);
    }
}

// ─── showCharGallery ──────────────────────────────────────────────────────────

async function showCharGallery(deleteModeState = false) {
    if (firstTime) {
        await loadFileToDocument(`${extensionFolderPath}nanogallery2.woff.min.css`, 'css');
        await loadFileToDocument(`${extensionFolderPath}jquery.nanogallery2.min.js`, 'js');
        firstTime = false;
        toastr.info('Images can also be found in the folder `user/images`', 'Drag and drop images onto the gallery to upload them', { timeOut: 6000 });
    }

    try {
        deleteModeActive = deleteModeState;
        let url = selected_group || this_chid;
        if (!selected_group && this_chid !== undefined) {
            url = getGalleryFolder(characters[this_chid]);
        }

        const items = await getGalleryItems(url);
        $('#dragGallery').closest('#gallery').remove();
        await makeMovable(url);
        await delay(100);
        await initGallery(items, url);
    } catch (err) {
        console.error(err);
    }
}

// ─── Upload ───────────────────────────────────────────────────────────────────

async function uploadFile(file, url) {
    try {
        const fileBase64 = await getBase64Async(file);
        const base64Data = fileBase64.split(',')[1];
        const extension = getFileExtension(file);
        const path = await saveBase64AsFile(base64Data, url, '', extension);
        toastr.success(t`File uploaded successfully. Saved at: ${path}`);
    } catch (error) {
        console.error('There was an issue uploading the file:', error);
        toastr.error(t`Failed to upload the file.`);
    }
}

// ─── makeMovable (panel builder) ─────────────────────────────────────────────

async function makeMovable(url) {
    console.debug('making new container from template');
    const id = 'gallery';
    const template = $('#generic_draggable_template').html();
    const newElement = $(template);
    newElement.css({ 'background-color': 'var(--SmartThemeBlurTintColor)', 'opacity': 0 });
    newElement.attr('forChar', id);
    newElement.attr('id', id);
    newElement.find('.drag-grabber').attr('id', `${id}header`);

    const dragTitle = newElement.find('.dragTitle');
    dragTitle.addClass('flex-container justifySpaceBetween alignItemsBaseline');
    dragTitle.addClass('gallery-panel-header');

    const titleText = document.createElement('span');
    titleText.textContent = t`Image Gallery`;
    titleText.classList.add('gallery-panel-title');
    dragTitle.append(titleText);

    // ── Controls row (sort + add) ──
    const controlsContainer = document.createElement('div');
    controlsContainer.classList.add('flex-container', 'alignItemsCenter', 'gallery-controls-row');

    const sortSelect = document.createElement('select');
    sortSelect.classList.add('gallery-sort-select');
    for (const sort of Object.values(SORT)) {
        const option = document.createElement('option');
        option.value = sort.value;
        option.textContent = sort.label;
        sortSelect.appendChild(option);
    }
    sortSelect.addEventListener('change', async () => {
        setSortOrder(sortSelect.options[sortSelect.selectedIndex].value);
        closeButton.trigger('click');
        await showCharGallery();
    });
    sortSelect.value = getSortOrder();

    const addImageButton = document.createElement('div');
    addImageButton.classList.add('menu_button', 'menu_button_icon', 'interactable', 'gallery-add-btn');
    addImageButton.title = t`Add Image`;
    addImageButton.innerHTML = '<i class="fa-solid fa-plus fa-fw"></i>';

    // ── Tag Mode toggle button ──
    const tagModeButton = document.createElement('div');
    tagModeButton.classList.add('right_menu_button', 'fa-solid', 'fa-tags', 'fa-fw', 'gallery-tag-mode-btn');
    tagModeButton.title = t`Tag Mode — click thumbnails to tag them`;
    tagModeButton.classList.toggle('gallery-mode-active', tagModeActive);
    tagModeButton.addEventListener('click', () => {
        tagModeActive = !tagModeActive;
        tagModeButton.classList.toggle('gallery-mode-active', tagModeActive);
        deleteModeActive = false; // mutually exclusive
        const dragGallery = document.getElementById('dragGallery');
        if (dragGallery) dragGallery.classList.toggle('gallery-tag-mode-on', tagModeActive);
        if (tagModeActive) {
            toastr.info(t`Tag Mode ON — click any image to tag it. Click again to turn off.`);
        } else {
            // Close any open popovers
            document.querySelectorAll('.gallery-tag-popover').forEach(p => p.remove());
        }
    });

    const fileInput = document.createElement('input');
    fileInput.type = 'file';
    fileInput.accept = 'image/*,video/*';
    fileInput.multiple = true;
    fileInput.style.display = 'none';

    addImageButton.addEventListener('click', () => fileInput.click());
    fileInput.addEventListener('change', async () => {
        const files = fileInput.files;
        if (files.length > 0) {
            for (const file of files) await uploadFile(file, url);
            closeButton.trigger('click');
            await showCharGallery();
        }
    });

    controlsContainer.append(sortSelect, addImageButton);
    dragTitle.append(controlsContainer);
    newElement.append(fileInput);

    newElement.addClass('no-scrollbar');

    const closeButton = newElement.find('.dragClose');
    closeButton.attr('id', `${id}close`);
    closeButton.attr('data-related-id', `${id}`);

    // ── Folder bar ──
    const topBarElement = document.createElement('div');
    topBarElement.classList.add('flex-container', 'alignItemsCenter', 'gallery-folder-bar');

    const onChangeFolder = async (/** @type {Event} */ e) => {
        if (e instanceof KeyboardEvent && e.key !== 'Enter') return;
        try {
            const newUrl = await getSanitizedFilename(galleryFolderInput.value);
            updateGalleryFolder(newUrl);
            closeButton.trigger('click');
            await showCharGallery();
            toastr.info(t`Gallery folder changed to ${newUrl}`);
            galleryFolderInput.value = newUrl;
        } catch (error) {
            console.error('Failed to change gallery folder:', error);
            toastr.error(error?.message || t`Unknown error`, t`Failed to change gallery folder`);
        }
    };

    const onRestoreFolder = async () => {
        try {
            restoreGalleryFolder();
            closeButton.trigger('click');
            await showCharGallery();
        } catch (error) {
            console.error('Failed to restore gallery folder:', error);
            toastr.error(error?.message || t`Unknown error`, t`Failed to restore gallery folder`);
        }
    };

    const galleryFolderInput = document.createElement('input');
    galleryFolderInput.type = 'text';
    galleryFolderInput.placeholder = t`Folder Name`;
    galleryFolderInput.title = t`Enter a folder name to change the gallery folder`;
    galleryFolderInput.value = url;
    galleryFolderInput.classList.add('text_pole', 'gallery-folder-input', 'flex1');
    galleryFolderInput.addEventListener('keyup', onChangeFolder);

    const galleryFolderAccept = document.createElement('div');
    galleryFolderAccept.classList.add('right_menu_button', 'fa-solid', 'fa-check', 'fa-fw');
    galleryFolderAccept.title = t`Change gallery folder`;
    galleryFolderAccept.addEventListener('click', onChangeFolder);

    const galleryDeleteMode = document.createElement('div');
    galleryDeleteMode.classList.add('right_menu_button', 'fa-solid', 'fa-trash', 'fa-fw');
    galleryDeleteMode.classList.toggle('warning', deleteModeActive);
    galleryDeleteMode.title = t`Delete mode`;
    galleryDeleteMode.addEventListener('click', () => {
        deleteModeActive = !deleteModeActive;
        galleryDeleteMode.classList.toggle('warning', deleteModeActive);
        if (deleteModeActive) toastr.info(t`Delete mode is ON. Click on images you want to delete.`);
    });

    const galleryFolderRestore = document.createElement('div');
    galleryFolderRestore.classList.add('right_menu_button', 'fa-solid', 'fa-recycle', 'fa-fw');
    galleryFolderRestore.title = t`Restore gallery folder`;
    galleryFolderRestore.addEventListener('click', onRestoreFolder);

    topBarElement.append(galleryFolderInput, galleryFolderAccept, tagModeButton, galleryDeleteMode, galleryFolderRestore);
    newElement.append(topBarElement);

    const folders = await getGalleryFolders();
    $(galleryFolderInput)
        .autocomplete({
            source: (i, o) => {
                const term = i.term.toLowerCase();
                o(folders.filter(f => f.toLowerCase().includes(term)));
            },
            select: (e, u) => {
                galleryFolderInput.value = u.item.value;
                onChangeFolder(e);
            },
            minLength: 0,
        })
        .on('focus', () => $(galleryFolderInput).autocomplete('search', ''));

    newElement.append('<div id="dragGallery"></div>');
    $('#dragGallery').css('display', 'block');
    $('#movingDivs').append(newElement);

    loadMovingUIState();
    $(`.draggable[forChar="${id}"]`).css('display', 'block');
    dragElement(newElement);
    newElement.transition({ opacity: 1, duration: animation_duration, easing: animation_easing });

    $(`.draggable[forChar="${id}"] img`).on('dragstart', (e) => {
        e.preventDefault();
        return false;
    });
}

// ─── Folder management ────────────────────────────────────────────────────────

function updateGalleryFolder(newUrl) {
    if (!newUrl) throw new Error('Folder name cannot be empty');
    const context = SillyTavern.getContext();
    if (context.groupId) throw new Error('Cannot change gallery folder in group chat');
    if (context.characterId === undefined) throw new Error('Character is not selected');
    const avatar = context.characters[context.characterId]?.avatar;
    const name = context.characters[context.characterId]?.name;
    if (!avatar) throw new Error('Character PNG ID is not found');
    if (newUrl === name) {
        delete context.extensionSettings.gallery.folders[avatar];
    } else {
        context.extensionSettings.gallery.folders[avatar] = newUrl;
    }
    context.saveSettingsDebounced();
}

function restoreGalleryFolder() {
    const context = SillyTavern.getContext();
    if (context.groupId) throw new Error('Cannot change gallery folder in group chat');
    if (context.characterId === undefined) throw new Error('Character is not selected');
    const avatar = context.characters[context.characterId]?.avatar;
    if (!avatar) throw new Error('Character PNG ID is not found');
    const existingOverride = context.extensionSettings.gallery.folders[avatar];
    if (!existingOverride) throw new Error('No folder override found');
    delete context.extensionSettings.gallery.folders[avatar];
    context.saveSettingsDebounced();
}

// ─── Sanitize HTML id ─────────────────────────────────────────────────────────

function sanitizeHTMLId(id) {
    return id.replace(/\s+/g, '-').replace(/[^\x00-\x7F]/g, '-').replace(/\W/g, '');
}

// ─── Slash commands ───────────────────────────────────────────────────────────

SlashCommandParser.addCommandObject(SlashCommand.fromProps({
    name: 'show-gallery',
    aliases: ['sg'],
    callback: () => { showCharGallery(); return ''; },
    helpString: 'Shows the gallery.',
}));

SlashCommandParser.addCommandObject(SlashCommand.fromProps({
    name: 'list-gallery',
    aliases: ['lg'],
    callback: listGalleryCommand,
    returns: 'list of images',
    namedArgumentList: [
        SlashCommandNamedArgument.fromProps({
            name: 'char',
            description: 'character name',
            typeList: [ARGUMENT_TYPE.STRING],
            enumProvider: commonEnumProviders.characters('character'),
        }),
        SlashCommandNamedArgument.fromProps({
            name: 'group',
            description: 'group name',
            typeList: [ARGUMENT_TYPE.STRING],
            enumProvider: commonEnumProviders.characters('group'),
        }),
    ],
    helpString: 'List images in the gallery of the current char / group or a specified char / group.',
}));

async function listGalleryCommand(args) {
    try {
        let url = args.char ?? (args.group ? groups.find(it => it.name == args.group)?.id : null) ?? (selected_group || this_chid);
        if (!args.char && !args.group && !selected_group && this_chid !== undefined) {
            url = getGalleryFolder(characters[this_chid]);
        }
        const items = await getGalleryItems(url);
        return JSON.stringify(items.map(it => it.src));
    } catch (err) {
        console.error(err);
    }
    return JSON.stringify([]);
}

// ─── Wand button ─────────────────────────────────────────────────────────────

function addGalleryWandButton() {
    const showGalleryContainer = document.getElementById('gallery_wand_container') || document.getElementById('extensionsMenu');
    if (!(showGalleryContainer instanceof HTMLElement)) return;
    const showGalleryButton = document.createElement('div');
    showGalleryButton.id = 'show_gallery_wand_button';
    showGalleryButton.classList.add('list-group-item', 'flex-container', 'flexGap5');
    const showGalleryIcon = document.createElement('div');
    showGalleryIcon.classList.add('fa-solid', 'fa-sd-card', 'extensionsMenuExtensionButton');
    const showGalleryText = document.createElement('span');
    showGalleryText.textContent = translate('Show Gallery');
    showGalleryButton.append(showGalleryIcon, showGalleryText);
    showGalleryButton.addEventListener('click', () => showCharGallery());
    showGalleryContainer.appendChild(showGalleryButton);
}

// ─── Init ─────────────────────────────────────────────────────────────────────

export async function init() {
    initSettings();

    eventSource.on(event_types.CHARACTER_RENAMED, (oldAvatar, newAvatar) => {
        const context = SillyTavern.getContext();
        const galleryFolder = context.extensionSettings.gallery.folders[oldAvatar];
        if (galleryFolder) {
            context.extensionSettings.gallery.folders[newAvatar] = galleryFolder;
            delete context.extensionSettings.gallery.folders[oldAvatar];
            context.saveSettingsDebounced();
        }
    });

    eventSource.on(event_types.CHARACTER_DELETED, (data) => {
        const avatar = data?.character?.avatar;
        if (!avatar) return;
        const context = SillyTavern.getContext();
        delete context.extensionSettings.gallery.folders[avatar];
        context.saveSettingsDebounced();
    });

    eventSource.on(event_types.CHARACTER_MANAGEMENT_DROPDOWN, (selectedOptionId) => {
        if (selectedOptionId === 'show_char_gallery') showCharGallery();
    });

    $('#char-management-dropdown').append(
        $('<option>', { id: 'show_char_gallery', text: translate('Show Gallery') }),
    );

    addGalleryWandButton();
}
