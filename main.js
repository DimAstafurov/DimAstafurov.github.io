// main.js
(function () {
  const LOG_PREFIX = "[VS Helper]";
  const API_BASE = "https://mis.ctcloud.ru";
  const MAX_PREV_VISITS_TO_SCAN = 2; // ограничение нагрузки на API

  function log(...args) {
    // Если надо выключить лог — просто закомментируй.
    console.log(LOG_PREFIX, ...args);
  }

  // --- Глобальный стейт в контексте страницы ---
  const state = {
    authToken: null,
    lastAuthHeaderSeenAt: 0,

    current: {
      visitId: null,
      subjectId: null,
      visitDate: null,
      visitIndex: null
    },

    subjects: {
      // subjectId: {
      //   visitsMeta: [ { subjectVisitId, visitDate, visitIndex } ],
      //   lastVs: {
      //     subjectVisitId,
      //     subjectFormId,
      //     subjectFormSectionId,
      //     loaded: false
      //   }
      // }
    },

    vsHistory: {
      // subjectId: {
      //   [fieldKey]: {
      //     value,
      //     unit,
      //     visitTitle,
      //     visitDate,
      //     timePoint,
      //     capturedAt
      //   }
      // }
    },

    lastUrl: location.href
  };

  // =========================
  // 1. Перехват XHR ради токена
  // =========================

  function patchXMLHttpRequestForAuth() {
    if (window.__vsHelperXhrPatched) return;
    window.__vsHelperXhrPatched = true;

    const OriginalXHR = window.XMLHttpRequest;

    function WrappedXHR() {
      const xhr = new OriginalXHR();
      let url = null;
      let method = null;

      const originalOpen = xhr.open;
      xhr.open = function (m, u, async, user, password) {
        method = m;
        url = u;
        return originalOpen.apply(xhr, arguments);
      };

      const originalSetRequestHeader = xhr.setRequestHeader;
      xhr.setRequestHeader = function (name, value) {
        try {
          if (name && typeof name === "string" &&
              name.toLowerCase() === "authorization" &&
              typeof value === "string" &&
              value.startsWith("Bearer ")) {
            state.authToken = value;
            state.lastAuthHeaderSeenAt = Date.now();
            //log("Captured auth token from XHR");
          }
        } catch (e) {
          console.warn(LOG_PREFIX, "Error capturing Authorization header", e);
        }
        return originalSetRequestHeader.apply(xhr, arguments);
      };

      // Если вдруг захочешь ловить ответные данные VS через XHR —
      // здесь можно добавить xhr.addEventListener('load', ...) и парсить JSON.
      // Сейчас это не требуется для работы алгоритма, т.к. мы сами дергаем API.

      return xhr;
    }

    WrappedXHR.prototype = OriginalXHR.prototype;
    window.XMLHttpRequest = WrappedXHR;

    log("XMLHttpRequest patched for Authorization header capture");
  }

  // =========================
  // 2. Хелперы для API
  // =========================

  async function waitForAuthToken(timeoutMs = 15000) {
    const start = Date.now();
    while (!state.authToken && Date.now() - start < timeoutMs) {
      await new Promise((r) => setTimeout(r, 200));
    }
    if (!state.authToken) {
      log("No auth token captured within timeout");
      throw new Error("Authorization token not available");
    }
  }

  async function fetchJsonWithAuth(path, options = {}) {
    await waitForAuthToken();
    const url = path.startsWith("http") ? path : API_BASE + path;

    const headers = new Headers(options.headers || {});
    if (!headers.has("accept")) {
      headers.set("accept", "application/json, text/plain, */*");
    }
    if (!headers.has("authorization")) {
      headers.set("authorization", state.authToken);
    }
    // немного мимикрируем под обычные запросы
    headers.set("cache-control", "no-cache");
    headers.set("pragma", "no-cache");

    const resp = await fetch(url, {
      method: options.method || "GET",
      headers,
      credentials: "include",
      body: options.body || null
    });

    if (!resp.ok) {
      const text = await resp.text().catch(() => "");
      log("fetchJsonWithAuth error", resp.status, resp.statusText, text.slice(0, 200));
      throw new Error(`HTTP ${resp.status} for ${path}`);
    }

    const ct = resp.headers.get("content-type") || "";
    if (!ct.includes("application/json")) {
      const text = await resp.text().catch(() => "");
      log("fetchJsonWithAuth non-JSON response", text.slice(0, 200));
      throw new Error("Non-JSON response");
    }

    try {
      return await resp.json();
    } catch (e) {
      log("fetchJsonWithAuth JSON parse error", e);
      throw e;
    }
  }

  // =========================
  // 3. Определение текущего визита
  // =========================

  function parseSubjectVisitIdFromUrl(url) {
    // URL-и вида:
    //  - https://mis.ctcloud.ru/subjectVisit/<subjectVisitId>
    //  - https://mis.ctcloud.ru/subjectVisit/<subjectVisitId>/timePoints
    const m = url.match(/\/subjectVisit\/([0-9a-fA-F-]+)/);
    return m ? m[1] : null;
  }

  async function ensureCurrentContext() {
    const visitId = parseSubjectVisitIdFromUrl(location.href);
    if (!visitId) {
      // Не страница визита — нам тут делать нечего
      return false;
    }

    if (state.current.visitId === visitId && state.current.subjectId) {
      return true;
    }

    log("Loading current SubjectVisit", visitId);

    const json = await fetchJsonWithAuth(`/api/SubjectsVisit/${visitId}`);
    const data = json && json.data;
    if (!data || !data.subject) {
      log("No subject in SubjectsVisit response");
      return false;
    }

    const subjectId = data.subject.id;
    const visitDate = data.date ? new Date(data.date) : null;
    const visitIndex = data.visit && typeof data.visit.index === "number"
      ? data.visit.index
      : null;

    state.current.visitId = visitId;
    state.current.subjectId = subjectId;
    state.current.visitDate = visitDate;
    state.current.visitIndex = visitIndex;

    log("Current context:", {
      visitId,
      subjectId,
      visitDate,
      visitIndex
    });

    return true;
  }

  // =========================
  // 4. Загрузка визитов субъекта
  // =========================

  async function ensureSubjectVisitsLoaded(subjectId) {
    if (!subjectId) return;

    if (state.subjects[subjectId] && state.subjects[subjectId].visitsMeta) {
      return;
    }

    log("Loading subject visits for", subjectId);

    const json = await fetchJsonWithAuth(`/api/Subjects/${subjectId}`);
    const data = json && json.data;
    if (!data || !Array.isArray(data.subjectVisitList)) {
      log("Subjects response has no subjectVisitList");
      state.subjects[subjectId] = state.subjects[subjectId] || {};
      state.subjects[subjectId].visitsMeta = [];
      return;
    }

    const visitsMeta = data.subjectVisitList.map((sv) => {
      const v = sv.visit || {};
      return {
        subjectVisitId: sv.id,
        visitDate: sv.date ? new Date(sv.date) : null,
        visitIndex: typeof v.index === "number" ? v.index : null,
        visitTitle: v.title || "",
        visitKey: v.visitKey || ""
      };
    });

    state.subjects[subjectId] = state.subjects[subjectId] || {};
    state.subjects[subjectId].visitsMeta = visitsMeta;

    log("Stored visits for subject", subjectId, "visits:", visitsMeta.length);
  }

  // =========================
  // 5. Поиск последнего визита с ЖВП
  // =========================

  function selectPreviousVisits(subjectId) {
    const subj = state.subjects[subjectId];
    if (!subj || !Array.isArray(subj.visitsMeta)) return [];

    const currentVisitId = state.current.visitId;
    const currentDate = state.current.visitDate;
    const currentIndex = state.current.visitIndex;

    const candidates = subj.visitsMeta
      .filter((v) => v.subjectVisitId !== currentVisitId)
      .map((v) => ({
        ...v,
        _cmpDate: v.visitDate ? v.visitDate.getTime() : 0,
        _cmpIndex: typeof v.visitIndex === "number" ? v.visitIndex : -9999
      }));

    // сортируем по дате/индексу убыванию — от самых поздних к более ранним
    candidates.sort((a, b) => {
      if (a._cmpDate !== b._cmpDate) return b._cmpDate - a._cmpDate;
      return b._cmpIndex - a._cmpIndex;
    });

    // фильтруем только те, что реально "раньше" текущего
    const filtered = candidates.filter((v) => {
      if (!currentDate) return true; // если дата текущего неизвестна — оставляем всё
      if (!v.visitDate) return false;
      if (v.visitDate.getTime() < currentDate.getTime()) return true;
      if (v.visitDate.getTime() > currentDate.getTime()) return false;
      // если даты равны — сравниваем index (меньший index считаем более ранним)
      if (currentIndex == null || v.visitIndex == null) return false;
      return v.visitIndex < currentIndex;
    });

    return filtered;
  }

  async function ensureLastVsVisitLoaded(subjectId) {
    if (!subjectId) return;

    const subj = (state.subjects[subjectId] = state.subjects[subjectId] || {});
    if (subj.lastVs && subj.lastVs.loaded) {
      return;
    }

    const prevVisits = selectPreviousVisits(subjectId);
    if (!prevVisits.length) {
      log("Subject has no previous visits", subjectId);
      subj.lastVs = { loaded: true, subjectVisitId: null };
      return;
    }

    // смотрим только первые N предыдущих визитов, чтобы не грохать API
    const limited = prevVisits.slice(0, MAX_PREV_VISITS_TO_SCAN);

    log(
      "Scanning previous visits for last VS",
      subjectId,
      "candidates:",
      limited.map((v) => v.subjectVisitId)
    );

    for (const v of limited) {
      const subjectVisitId = v.subjectVisitId;
      try {
        const json = await fetchJsonWithAuth(`/api/SubjectsVisit/${subjectVisitId}`);
        const data = json && json.data;
        if (!data || !Array.isArray(data.subjectFormList)) {
          continue;
        }

        // Ищем форму ЖВП
        const vsForm = data.subjectFormList.find((sf) => {
          if (sf.isDeleted) return false;
          const form = sf.form || {};
          const formType = form.formType || {};
          const formKey = form.formKey || "";
          const formTypeKey = formType.formTypeKey || "";
          const title = (form.title || "").toLowerCase();

          const looksLikeVS =
            formTypeKey === "VS" ||
            formKey === "F_VS" ||
            title.includes("жизненно-важные показател");

          const isComplete = !!sf.isComplete;

          return looksLikeVS && isComplete;
        });

        if (!vsForm) {
          continue;
        }

        // Внутри есть subjectFormSectionList, там секции типа FS_VS_0
        const vsSection = Array.isArray(data.subjectFormSectionList)
          ? data.subjectFormSectionList.find((s) => {
              if (!s.subjectForm) return false;
              return s.subjectForm.id === vsForm.id;
            })
          : null;

        if (!vsSection) {
          log(
            "Found VS form but no matching section in subjectFormSectionList",
            subjectVisitId
          );
          continue;
        }

        const lastVs = {
          subjectVisitId,
          subjectFormId: vsForm.id,
          subjectFormSectionId: vsSection.id,
          loaded: false,
          visitTitle: (data.visit && data.visit.title) || v.visitTitle || "",
          visitDate: data.date ? new Date(data.date) : v.visitDate
        };

        subj.lastVs = lastVs;

        log("Found last VS visit", {
          subjectId,
          lastVs
        });

        // подгружаем поля ЖВП для этой секции
        await loadVsFieldsForSection(subjectId, lastVs);

        lastVs.loaded = true;
        return;
      } catch (e) {
        console.warn(LOG_PREFIX, "ensureLastVsVisitLoaded error for visit", subjectVisitId, e);
      }
    }

    log("No previous visit with VS found for subject", subjectId);
    subj.lastVs = { loaded: true, subjectVisitId: null };
  }

  // =========================
  // 6. Загрузка полей ЖВП (последний визит)
  // =========================

  async function loadVsFieldsForSection(subjectId, lastVs) {
    if (!lastVs || !lastVs.subjectFormSectionId) return;

    const sectionId = lastVs.subjectFormSectionId;

    // ВАЖНО:
    // Ниже — предположение по API:
    //   GET /api/SubjectFormSection/{id}
    // должен вернуть data.subjectFormFieldList с полями, где есть fieldKey и value.
    //
    // Проверь в devtools:
    //   - открой любую форму ЖВП
    //   - посмотри XHR, находящийся рядом с SubjectFormSection
    //   - если путь отличается — поправь только этот endpoint и разбор полей.

    log("Loading VS fields for section", sectionId);

    const json = await fetchJsonWithAuth(`/api/SubjectsForm/${sectionId}`);
    const data = json && json.data;
    if (!data || !Array.isArray(data.subjectFormFieldList)) {
      log("SubjectFormSection has no subjectFormFieldList", sectionId);
      return;
    }

    const subjectHistory = (state.vsHistory[subjectId] = state.vsHistory[subjectId] || {});

    for (const f of data.subjectFormFieldList) {
      const formField = f.formField || {};
      const key =
        f.formFieldKey ||
        formField.formFieldKey ||
        formField.fieldKey ||
        formField.key ||
        null;

      if (!key) continue;

      // Значение может быть в разных полях. Ниже — типичный вариант,
      // возможно, надо будет подправить под конкретный JSON:
      const rawValue =
        f.value ??
        f.valueString ??
        f.valueNumber ??
        f.valueDecimal ??
        f.valueInt ??
        null;

      if (rawValue == null || rawValue === "") {
        continue;
      }

      const unit =
        f.unit ||
        (formField.unit && formField.unit.title) ||
        null;

      const timePoint =
        (f.timePoint && f.timePoint.title) ||
        (f.timePointTitle) ||
        null;

      subjectHistory[key] = {
        value: rawValue,
        unit: unit,
        visitTitle: lastVs.visitTitle || "",
        visitDate: lastVs.visitDate || null,
        timePoint: timePoint,
        capturedAt: new Date()
      };
    }

    log(
      "Stored VS fields for subject",
      subjectId,
      "fields:",
      Object.keys(subjectHistory)
    );
  }

  // =========================
  // 7. Инъекция подсказок в DOM
  // =========================

  function formatDateTime(d) {
    if (!(d instanceof Date) || Number.isNaN(d.getTime())) return "";
    const dd = String(d.getDate()).padStart(2, "0");
    const mm = String(d.getMonth() + 1).padStart(2, "0");
    const yyyy = d.getFullYear();
    const hh = String(d.getHours()).padStart(2, "0");
    const mi = String(d.getMinutes()).padStart(2, "0");
    return `${dd}.${mm}.${yyyy} ${hh}:${mi}`;
  }

  function attachHintToField(inputEl, fieldKey) {
    const subjectId = state.current.subjectId;
    if (!subjectId) return;

    const subjectHistory = state.vsHistory[subjectId];
    const entry = subjectHistory && subjectHistory[fieldKey];

    let container = inputEl.parentElement.querySelector(
      ".vs-helper-container[data-field-key='" + fieldKey + "']"
    );
    if (!container) {
      container = document.createElement("div");
      container.className = "vs-helper-container";
      container.dataset.fieldKey = fieldKey;
      // вставляем сразу после input-а
      if (inputEl.nextSibling) {
        inputEl.parentElement.insertBefore(container, inputEl.nextSibling);
      } else {
        inputEl.parentElement.appendChild(container);
      }
    } else {
      container.innerHTML = "";
    }

    const labelSpan = document.createElement("span");
    labelSpan.className = "vs-helper-label";

    if (!entry) {
      labelSpan.textContent = "Предыдущие ЖВП: данных нет.";
      container.appendChild(labelSpan);
      return;
    }

    labelSpan.textContent = "Предыдущее значение: ";

    const valueSpan = document.createElement("span");
    valueSpan.className = "vs-helper-value";
    valueSpan.textContent =
      entry.value + (entry.unit ? " " + entry.unit : "");

    const metaSpan = document.createElement("span");
    metaSpan.className = "vs-helper-meta";

    const parts = [];
    if (entry.visitTitle) parts.push(entry.visitTitle);
    if (entry.visitDate) parts.push(formatDateTime(entry.visitDate));
    if (entry.timePoint) parts.push(entry.timePoint);

    if (parts.length) {
      metaSpan.textContent = " (" + parts.join(", ") + ")";
    }

    container.appendChild(labelSpan);
    container.appendChild(valueSpan);
    container.appendChild(metaSpan);

    // Кнопка истории — пока показывает только последний визит,
    // но интерфейс готов, если захочешь докрутить массив значений
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "vs-helper-btn-history";
    btn.textContent = "история";

    let popup = null;

    function closePopup() {
      if (popup && popup.parentElement) {
        popup.parentElement.removeChild(popup);
      }
      popup = null;
      document.removeEventListener("click", onDocClick, true);
    }

    function onDocClick(e) {
      if (!popup) return;
      if (!popup.contains(e.target) && e.target !== btn) {
        closePopup();
      }
    }

    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      if (popup) {
        closePopup();
        return;
      }

      popup = document.createElement("div");
      popup.className = "vs-helper-popup";

      const ul = document.createElement("ul");
      const li = document.createElement("li");
      li.textContent =
        "Последний визит: " +
        (entry.visitTitle || "без названия") +
        (entry.visitDate ? " — " + formatDateTime(entry.visitDate) : "") +
        (entry.timePoint ? " — " + entry.timePoint : "");
      ul.appendChild(li);
      popup.appendChild(ul);

      // позиционируем рядом с кнопкой
      const rect = btn.getBoundingClientRect();
      popup.style.left = rect.left + window.scrollX + "px";
      popup.style.top = rect.bottom + window.scrollY + 4 + "px";

      document.body.appendChild(popup);
      document.addEventListener("click", onDocClick, true);
    });

    container.appendChild(btn);
  }

  function scanAndInjectForAllFields() {
    const subjectId = state.current.subjectId;
    if (!subjectId) return;

    const subjectHistory = state.vsHistory[subjectId];
    if (!subjectHistory || !Object.keys(subjectHistory).length) {
      log("scanAndInjectForAllFields: history is empty for subject", subjectId);
      return;
    }

    // Предполагаем, что у контейнера поля есть data-field-key,
    // которое совпадает с fieldKey в API.
    // Если в DOM оно висит, например, на обертке — подправь селектор.
    const fieldContainers = document.querySelectorAll("[data-field-key]");

    fieldContainers.forEach((container) => {
      const fieldKey = container.getAttribute("data-field-key");
      if (!fieldKey) return;

      const input = container.querySelector("input, textarea, select");
      if (!input) return;

      attachHintToField(input, fieldKey);
    });
  }

  // =========================
  // 8. Отслеживание смены URL (SPA)
  // =========================

  function startUrlWatcher() {
    setInterval(async () => {
      const currentUrl = location.href;
      if (currentUrl === state.lastUrl) return;
      state.lastUrl = currentUrl;

      try {
        await mainFlow();
      } catch (e) {
        console.warn(LOG_PREFIX, "Error in mainFlow after URL change", e);
      }
    }, 1000);
  }

  // =========================
  // 9. Основной сценарий
  // =========================

  async function mainFlow() {
    // 1) убедились, что можем поймать токен
    await waitForAuthToken();

    // 2) определяем текущий визит/субъект
    const ok = await ensureCurrentContext();
    if (!ok) return;

    const subjectId = state.current.subjectId;
    if (!subjectId) return;

    // 3) загружаем список визитов субъекта (один раз)
    await ensureSubjectVisitsLoaded(subjectId);

    // 4) ищем последний визит с ЖВП и подгружаем его значения (один раз)
    await ensureLastVsVisitLoaded(subjectId);

    // 5) сканируем DOM и подставляем подсказки
    scanAndInjectForAllFields();
  }

  // =========================
  // 10. Инициализация
  // =========================

  function init() {
    try {
      patchXMLHttpRequestForAuth();
      startUrlWatcher();

      // Первый запуск сразу
      mainFlow().catch((e) => {
        console.warn(LOG_PREFIX, "Error in initial mainFlow", e);
      });
    } catch (e) {
      console.error(LOG_PREFIX, "Fatal init error", e);
    }
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
