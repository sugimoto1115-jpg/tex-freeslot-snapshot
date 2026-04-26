import { PDFViewerApplicationOptions } from "./pdf.js/web/viewer.mjs";

function loadConfig() {
  const elem = document.getElementById("pdf-view-config");
  if (elem) {
    return JSON.parse(elem.getAttribute("data-config"));
  }
  throw new Error("Could not load configuration.");
}

const config = loadConfig();
const vscodeApi =
  typeof acquireVsCodeApi === "function" ? acquireVsCodeApi() : null;
const STORAGE_KEY = `pdf-view-state:${config.url}`;

PDFViewerApplicationOptions.set("defaultUrl", "");
PDFViewerApplicationOptions.set("disablePreferences", true);
PDFViewerApplicationOptions.set(
  "defaultZoomValue",
  config.defaultZoomValue ?? "auto"
);
PDFViewerApplicationOptions.set(
  "sidebarViewOnLoad",
  config.sidebarViewOnLoad ?? 0
);

document.addEventListener(
  "keydown",
  (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key === "p") {
      e.preventDefault();
      e.stopImmediatePropagation();
    }
  },
  true
);

function readState() {
  try {
    const state = vscodeApi?.getState?.();
    if (state) return state;
  } catch {}
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) return JSON.parse(raw);
  } catch {}
  return null;
}

function writeState(state) {
  try {
    vscodeApi?.setState?.(state);
  } catch {}
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch {}
}

function captureState() {
  const viewer = window.PDFViewerApplication?.pdfViewer;
  const container = viewer?.container;
  return {
    currentPageNumber: viewer?.currentPageNumber ?? 1,
    currentScaleValue: viewer?.currentScaleValue ?? "auto",
    scrollLeft: container?.scrollLeft ?? 0,
    scrollTop: container?.scrollTop ?? 0,
  };
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function applyState(state) {
  if (!state) return;
  const viewer = window.PDFViewerApplication?.pdfViewer;
  if (!viewer) return;

  await viewer.pagesPromise;

  const page = Math.min(
    Math.max(state.currentPageNumber ?? 1, 1),
    viewer.pagesCount || 1
  );

  try {
    if (state.currentScaleValue) {
      viewer.currentScaleValue = state.currentScaleValue;
    }
  } catch {}

  viewer.currentPageNumber = page;

  const container = viewer.container;
  if (container) {
    if (typeof state.scrollLeft === "number") container.scrollLeft = state.scrollLeft;
    if (typeof state.scrollTop === "number") container.scrollTop = state.scrollTop;
  }
}

async function restoreState(state) {
  if (!state) return;
  for (const ms of [0, 50, 150, 400, 900]) {
    await sleep(ms);
    await applyState(state);
  }
}

function setupStateTracking() {
  const app = window.PDFViewerApplication;
  const viewer = app?.pdfViewer;
  const container = viewer?.container;
  const save = () => writeState(captureState());

  container?.addEventListener("scroll", save, { passive: true });
  app?.eventBus?.on("pagechanging", save);
  app?.eventBus?.on("scalechanging", save);
  app?.eventBus?.on("updateviewarea", save);

  window.addEventListener("beforeunload", save);
  save();
}

async function openConfiguredPdf() {
  await window.PDFViewerApplication.initializedPromise;
  await window.PDFViewerApplication.open(config);
  const [, hash] = config.url.split("#");
  if (hash) {
    window.PDFViewerApplication.pdfLinkService.setHash(
      decodeURIComponent(hash)
    );
  }
}

void (async () => {
  await openConfiguredPdf();
  await restoreState(readState());
  setupStateTracking();
})();

window.addEventListener("message", async (event) => {
  await window.PDFViewerApplication.initializedPromise;

  switch (event.data.action) {
    case "reload": {
      const state = captureState();
      writeState(state);
      await openConfiguredPdf();
      await restoreState(state);
      writeState(captureState());
      break;
    }
  }
});

window.addEventListener("error", (error) => {
  console.error(error);
});
