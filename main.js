// content-script.js
// ============================================================================
// VS Helper — подсказки по последним ЖВП для форм "Жизненно-важные показатели"
// ============================================================================

(function () {
  "use strict";

  // ----------------------------
  // Общие утилиты и логирование
  // ----------------------------

  const LOG_PREFIX = "[VS Helper]";

  function log(...args) {
    console.log(LOG_PREFIX, ...args);
  }

  function warn(...args) {
    console.warn(LOG_PREFIX, ...args);
  }

  function error(...args) {
    console.error(LOG_PREFIX, ...args);
  }

  function safeJsonParse(text) {
    try {
      return JSON.parse(text);
    } catch (e) {
      return null;
    }
  }

  function getBaseUrl() {
    return window.location.origin;
  }

  function getPathname() {
    return window.location.pathname || "/";
  }

  // ----------------------------------------
  // Парсинг ID из URL
  // ----------------------------------------

  function parseSubjectIdFromUrl(pathname) {
    const m = pathname.match(/\/subject\/([0-9a-fA-F-]{36})/);
    return m ? m[1] : null;
  }

  function parseSubjectVisitIdFromUrl(pathname) {
    const m = pathname.match(/\/subjectVisit\/([0-9a-fA-F-]{36})/);
    return m ? m[1] : null;
  }

  // -----------------------------------
  // Глобальное состояние
  // -----------------------------------

  // subjectId → { raw, visits: [{ subjectVisitId, date, formCompletedStatus, visitTitle }] }
  const subjectCache = new Map();

  // subjectVisitId → { raw, subjectFormList }
  const subjectVisitCache = new Map();

  // subjectVisitId → subjectId
  const subjectByVisit = new Map();

  // subjectId → { fieldKey: { value, units, dateTime, visitTitle, visitDate, subjectVisitId, fieldTitle } }
  const lastVsHistoryBySubject = new Map();

  const pageState = {
    currentSubjectId: null,
    currentSubjectVisitId: null,
    injectionScheduled: false,
  };

  // ----------------------------
  // Кэш и ensure*-функции
  // ----------------------------

  function onSubjectsResponse(subjectId, data) {
    if (!subjectId || !data) return;

    const subjectVisitList = Array.isArray(data.subjectVisitList)
      ? data.subjectVisitList
      : [];

    const visits = subjectVisitList.map((sv) => ({
      subjectVisitId: sv.id,
      date: sv.date ? new Date(sv.date) : null,
      formCompletedStatus: sv.formCompletedStatus || null,
      visitTitle: sv.visit && sv.visit.title ? sv.visit.title : "",
    }));

    subjectCache.set(subjectId, {
      raw: data,
      visits,
    });

    for (const v of visits) {
      if (v.subjectVisitId) {
        subjectByVisit.set(v.subjectVisitId, subjectId);
      }
    }

    log("Stored visits for subject", subjectId, "visits:", visits.length);
  }

  function onSubjectVisitResponse(subjectVisitId, data) {
    if (!subjectVisitId || !data) return;

    subjectVisitCache.set(subjectVisitId, {
      raw: data,
      subjectFormList: Array.isArray(data.subjectFormList)
        ? data.subjectFormList
        : [],
    });

    // Связываем визит с субъектом, НО НЕ трогаем subjectCache
    const subject = data.subject || {};
    if (subject.id) {
      subjectByVisit.set(subjectVisitId, subject.id);
    }

    log(
      "Stored subjectVisit",
      subjectVisitId,
      "forms:",
      (data.subjectFormList || []).length
    );
  }

  // ---- ИСПРАВЛЕНО: устойчивый парсинг JSON для Subject ----
  async function ensureSubjectLoaded(subjectId, baseUrl) {
    if (!subjectId) return null;

    const cached = subjectCache.get(subjectId);
    if (
      cached &&
      cached.raw &&
      Array.isArray(cached.visits) &&
      cached.visits.length > 0
    ) {
      return cached;
    }

    try {
      log("ensureSubjectLoaded: fetching /api/Subjects/", subjectId);
      const resp = await fetch(`${baseUrl}/api/Subjects/${subjectId}`, {
        credentials: "include",
      });

      if (!resp.ok) {
        warn(
          "ensureSubjectLoaded: non-OK response",
          resp.status,
          resp.statusText
        );
        return null;
      }

      const text = await resp.text();
      if (!text || !text.trim()) {
        warn(
          "ensureSubjectLoaded: empty response body for subject",
          subjectId
        );
        return null;
      }

      const json = safeJsonParse(text);
      if (!json || !json.data) {
        warn("ensureSubjectLoaded: no data in JSON for subject", subjectId);
        return null;
      }

      onSubjectsResponse(subjectId, json.data);
      return subjectCache.get(subjectId) || null;
    } catch (e) {
      error("ensureSubjectLoaded failed for subject", subjectId, e);
      return null;
    }
  }

  // ---- ИСПРАВЛЕНО: устойчивый парсинг JSON для SubjectVisit ----
  async function ensureSubjectVisitLoaded(subjectVisitId, baseUrl) {
    if (!subjectVisitId) return null;
    if (subjectVisitCache.has(subjectVisitId)) {
      return subjectVisitCache.get(subjectVisitId);
    }

    try {
      log(
        "ensureSubjectVisitLoaded: fetching /api/SubjectsVisit/",
        subjectVisitId
      );
      const resp = await fetch(
        `${baseUrl}/api/SubjectsVisit/${subjectVisitId}`,
        {
          credentials: "include",
        }
      );

      if (!resp.ok) {
        warn(
          "ensureSubjectVisitLoaded: non-OK response",
          resp.status,
          resp.statusText,
          "for visit",
          subjectVisitId
        );
        return null;
      }

      const text = await resp.text();
      if (!text || !text.trim()) {
        warn(
          "ensureSubjectVisitLoaded: empty response body for visit",
          subjectVisitId
        );
        return null;
      }

      const json = safeJsonParse(text);
      if (!json || !json.data) {
        warn("ensureSubjectVisitLoaded: no data in JSON for visit", subjectVisitId);
        return null;
      }

      onSubjectVisitResponse(subjectVisitId, json.data);
      return subjectVisitCache.get(subjectVisitId) || null;
    } catch (e) {
      error("ensureSubjectVisitLoaded failed for visit", subjectVisitId, e);
      return null;
    }
  }

  // -----------------------------------------
  // Разбор формы ЖВП из /api/SubjectsForm/*
  // -----------------------------------------

  function extractVsValuesFromSubjectForm(formJson) {
    const result = [];
    if (!formJson || !formJson.data) return result;
    const f = formJson.data;

    const subjectVisitId =
      f.subjectVisitId || (f.subjectVisit && f.subjectVisit.id) || null;

    const formMeta = f.form || f.formType || {};
    const formTitle = formMeta.title || formMeta.name || "";
    const formTypeKey =
      formMeta.formTypeKey || formMeta.key || formMeta.code || null;

    const isVsForm =
      (formTypeKey && formTypeKey.toUpperCase() === "VS") ||
      /Жизненно-важные показатели/i.test(formTitle);

    if (!isVsForm) {
      return result;
    }

    const list =
      f.fieldValueList ||
      f.fieldValueDtoList ||
      f.fieldValues ||
      f.values ||
      [];

    if (!Array.isArray(list) || !list.length) {
      log("VS form has no field values, formId =", f.id);
      return result;
    }

    for (const fv of list) {
      const field = fv.field || fv.formField || {};
      const fieldKey =
        field.fieldKey || field.key || field.code || field.name || null;
      const fieldTitle = field.title || field.label || "";
      const units = field.units || field.unit || "";

      const value =
        fv.value ??
        fv.fieldValue ??
        fv.numberValue ??
        fv.stringValue ??
        fv.boolValue ??
        null;

      if (!fieldKey || value === null || value === undefined || value === "") {
        continue;
      }

      const capturedAt =
        fv.capturedAt ||
        fv.dateTime ||
        f.updatedAt ||
        f.createdAt ||
        null;

      result.push({
        subjectVisitId,
        fieldKey,
        fieldTitle,
        units,
        value,
        capturedAt: capturedAt ? new Date(capturedAt) : null,
        formTitle,
      });
    }

    return result;
  }

  // ----------------------------------------------------
  // Загрузка ТОЛЬКО последнего предыдущего визита с ЖВП
  // ----------------------------------------------------

  async function ensureLastVsHistoryLoaded(subjectId, currentSubjectVisitId) {
    if (!subjectId || !currentSubjectVisitId) return;

    const baseUrl = getBaseUrl();

    if (
      lastVsHistoryBySubject.has(subjectId) &&
      Object.keys(lastVsHistoryBySubject.get(subjectId) || {}).length > 0
    ) {
      return;
    }

    const subjectInfo = await ensureSubjectLoaded(subjectId, baseUrl);
    if (!subjectInfo) {
      warn("ensureLastVsHistoryLoaded: no subject info for", subjectId);
      return;
    }

    const visits = subjectInfo.visits || [];
    if (!visits.length) {
      warn("ensureLastVsHistoryLoaded: subject has no visits", subjectId);
      lastVsHistoryBySubject.set(subjectId, {});
      return;
    }

    const currentVisitMeta = visits.find(
      (v) => v.subjectVisitId === currentSubjectVisitId
    );
    const currentDate = currentVisitMeta ? currentVisitMeta.date : null;

    const sorted = [...visits].filter((v) => v.subjectVisitId);
    sorted.sort((a, b) => {
      const ad = a.date ? a.date.getTime() : 0;
      const bd = b.date ? b.date.getTime() : 0;
      return bd - ad;
    });

    let lastVsVisitId = null;
    let lastVsVisitTitle = "";
    let lastVsVisitDate = null;

    for (const v of sorted) {
      if (!v.subjectVisitId) continue;
      if (v.subjectVisitId === currentSubjectVisitId) continue;
      if (v.formCompletedStatus && v.formCompletedStatus === "Empty") continue;

      if (currentDate && v.date && v.date.getTime() >= currentDate.getTime()) {
        continue;
      }

      const svDetails = await ensureSubjectVisitLoaded(
        v.subjectVisitId,
        baseUrl
      );
      if (!svDetails) continue;

      const forms = svDetails.subjectFormList || [];
      if (!forms.length) continue;

      const vsForms = forms.filter((f) => {
        const formType = f.formType || {};
        const title = formType.title || f.title || "";
        const key =
          formType.formTypeKey ||
          formType.key ||
          (formType.code || "").toUpperCase();
        const byKey = key && key.toUpperCase() === "VS";
        const byTitle = /Жизненно-важные показатели/i.test(title);
        return byKey || byTitle;
      });

      if (vsForms.length) {
        lastVsVisitId = v.subjectVisitId;
        lastVsVisitTitle = v.visitTitle || "";
        lastVsVisitDate = v.date || null;
        log(
          "Found last previous VS visit",
          lastVsVisitId,
          "title:",
          lastVsVisitTitle
        );
        break;
      }
    }

    if (!lastVsVisitId) {
      log(
        "No previous visit with VS found for subject",
        subjectId,
        "current visit",
        currentSubjectVisitId
      );
      lastVsHistoryBySubject.set(subjectId, {});
      return;
    }

    const lastVisitDetails =
      subjectVisitCache.get(lastVsVisitId) ||
      (await ensureSubjectVisitLoaded(lastVsVisitId, baseUrl));

    if (!lastVisitDetails) {
      warn("Cannot load last VS visit details for", lastVsVisitId);
      lastVsHistoryBySubject.set(subjectId, {});
      return;
    }

    const vsForms = (lastVisitDetails.subjectFormList || []).filter((f) => {
      const formType = f.formType || {};
      const title = formType.title || f.title || "";
      const key =
        formType.formTypeKey ||
        formType.key ||
        (formType.code || "").toUpperCase();
      const byKey = key && key.toUpperCase() === "VS";
      const byTitle = /Жизненно-важные показатели/i.test(title);
      return byKey || byTitle;
    });

    if (!vsForms.length) {
      warn(
        "Last VS visit has no VS forms (unexpected)",
        lastVsVisitId,
        lastVisitDetails
      );
      lastVsHistoryBySubject.set(subjectId, {});
      return;
    }

    const history = {};

    for (const f of vsForms) {
      const subjectFormId = f.id;
      if (!subjectFormId) continue;

      try {
        const resp = await fetch(
          `${baseUrl}/api/SubjectsForm/${subjectFormId}`,
          {
            credentials: "include",
          }
        );

        if (!resp.ok) {
          warn(
            "Failed to load SubjectForm",
            subjectFormId,
            "status",
            resp.status
          );
          continue;
        }

        const text = await resp.text();
        if (!text || !text.trim()) {
          warn("Empty SubjectForm body", subjectFormId);
          continue;
        }

        const json = safeJsonParse(text);
        if (!json) {
          warn("Invalid JSON in SubjectForm", subjectFormId);
          continue;
        }

        const values = extractVsValuesFromSubjectForm(json);

        for (const v of values) {
          const key = v.fieldKey;
          if (!key) continue;

          const existing = history[key];
          const newDt = v.capturedAt || lastVsVisitDate;
          if (!existing) {
            history[key] = {
              value: v.value,
              units: v.units,
              dateTime: newDt,
              visitTitle: lastVsVisitTitle,
              visitDate: lastVsVisitDate,
              subjectVisitId: lastVsVisitId,
              fieldTitle: v.fieldTitle,
            };
          } else {
            const oldDt = existing.dateTime || existing.visitDate || null;
            if (newDt && (!oldDt || newDt.getTime() > oldDt.getTime())) {
              history[key] = {
                value: v.value,
                units: v.units,
                dateTime: newDt,
                visitTitle: lastVsVisitTitle,
                visitDate: lastVsVisitDate,
                subjectVisitId: lastVsVisitId,
                fieldTitle: v.fieldTitle,
              };
            }
          }
        }
      } catch (e) {
        error("Failed to load SubjectForm", subjectFormId, e);
      }
    }

    lastVsHistoryBySubject.set(subjectId, history);
    log(
      "Built last VS history for subject",
      subjectId,
      "fields:",
      Object.keys(history)
    );
  }

  // ---------------------------------------------
  // Инъекция подсказок под полями формы ЖВП
  // ---------------------------------------------

  function findAllNumericInputsInVsForm() {
    const root = document.querySelector("#root");
    if (!root) return [];
    const inputs = Array.from(
      root.querySelectorAll(
        "input[type='number'], input[inputmode='decimal'], input[role='spinbutton']"
      )
    );
    return inputs;
  }

  function findFieldKeyForInput(input) {
    const container = input.closest("div");
    if (!container) return null;

    const label =
      container.querySelector("label") ||
      container.previousElementSibling ||
      null;

    const labelText = label ? (label.textContent || "").trim() : "";

    if (/САД/i.test(labelText)) return "SAD";
    if (/ДАД/i.test(labelText)) return "DAD";
    if (/ЧСС/i.test(labelText)) return "HR";
    if (/Частота пульса/i.test(labelText)) return "HR1";
    if (/Температура тела/i.test(labelText)) return "TEMP";
    if (/ЧДД/i.test(labelText)) return "BR";

    const dk =
      input.getAttribute("data-field-key") ||
      (container.getAttribute && container.getAttribute("data-field-key"));
    if (dk) return dk;

    return null;
  }

  function createHintElement(text, moreClickHandler) {
    const wrapper = document.createElement("div");
    wrapper.style.fontSize = "11px";
    wrapper.style.color = "#555";
    wrapper.style.marginTop = "2px";
    wrapper.style.display = "flex";
    wrapper.style.alignItems = "center";
    wrapper.style.gap = "4px";

    const span = document.createElement("span");
    span.textContent = text;
    wrapper.appendChild(span);

    if (typeof moreClickHandler === "function") {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.textContent = "Подробнее";
      btn.style.fontSize = "10px";
      btn.style.padding = "1px 4px";
      btn.style.cursor = "pointer";
      btn.addEventListener("click", (e) => {
        e.stopPropagation();
        moreClickHandler();
      });
      wrapper.appendChild(btn);
    }

    return wrapper;
  }

  function injectHintsForCurrentForm() {
    const { currentSubjectId, currentSubjectVisitId } = pageState;
    if (!currentSubjectId || !currentSubjectVisitId) {
      log(
        "injectHintsForCurrentForm: no subjectId or currentSubjectVisitId",
        currentSubjectId,
        currentSubjectVisitId
      );
      return;
    }

    const history = lastVsHistoryBySubject.get(currentSubjectId) || {};
    if (!history || !Object.keys(history).length) {
      log(
        "scanAndInjectForAllFields: history is empty for subject",
        currentSubjectId
      );
      return;
    }

    const inputs = findAllNumericInputsInVsForm();
    if (!inputs.length) {
      log("injectHintsForCurrentForm: no numeric inputs found on page");
      return;
    }

    for (const input of inputs) {
      const fieldKey = findFieldKeyForInput(input);
      if (!fieldKey) continue;

      const h = history[fieldKey];
      if (!h) continue;

      const parent = input.parentElement;
      if (!parent) continue;
      const existingHint = parent.querySelector(
        "[data-vs-helper-hint='1']"
      );
      if (existingHint) continue;

      const dateStr = h.dateTime
        ? h.dateTime.toLocaleString()
        : h.visitDate
        ? h.visitDate.toLocaleDateString()
        : "";

      const hintTextParts = [];
      hintTextParts.push(`Предыдущее значение: ${h.value}`);
      if (h.units) hintTextParts.push(h.units);
      if (h.visitTitle) hintTextParts.push(`(${h.visitTitle})`);
      if (dateStr) hintTextParts.push(`от ${dateStr}`);

      const hintEl = createHintElement(hintTextParts.join(" "), () => {
        alert(
          `Последние данные ЖВП по полю ${fieldKey}:\n` +
            `Значение: ${h.value} ${h.units || ""}\n` +
            `Визит: ${h.visitTitle || ""}\n` +
            `Дата/время: ${dateStr || "неизвестно"}`
        );
      });

      hintEl.setAttribute("data-vs-helper-hint", "1");

      parent.appendChild(hintEl);
    }

    log(
      "injectHintsForCurrentForm: hints injected for subject",
      currentSubjectId
    );
  }

  // ----------------------------------------------------
  // XHR перехват
  // ----------------------------------------------------

  (function patchXHR() {
    const origOpen = XMLHttpRequest.prototype.open;
    const origSend = XMLHttpRequest.prototype.send;

    XMLHttpRequest.prototype.open = function (method, url) {
      this.__vsHelper = this.__vsHelper || {};
      this.__vsHelper.method = method;
      this.__vsHelper.url = url;
      return origOpen.apply(this, arguments);
    };

    XMLHttpRequest.prototype.send = function (body) {
      if (this.__vsHelper) {
        this.addEventListener("load", () => {
          try {
            handleXhrLoad(this.__vsHelper.method, this.__vsHelper.url, this);
          } catch (e) {
            error("handleXhrLoad failed", e);
          }
        });
      }
      return origSend.apply(this, arguments);
    };

    log("XMLHttpRequest patched");
  })();

  function handleXhrLoad(method, url, xhr) {
    if (!url || xhr.status < 200 || xhr.status >= 300) return;

    let fullUrl;
    try {
      fullUrl = new URL(url, window.location.origin);
    } catch {
      return;
    }

    const pathname = fullUrl.pathname;
    if (!pathname.startsWith("/api/")) return;

    const text = xhr.responseText;
    if (!text) return;

    const json = safeJsonParse(text);
    if (!json || !json.data) return;

    const subjMatch = pathname.match(/\/api\/Subjects\/([0-9a-fA-F-]{36})$/);
    if (subjMatch) {
      const subjectId = subjMatch[1];
      onSubjectsResponse(subjectId, json.data);
      return;
    }

    const svMatch = pathname.match(
      /\/api\/SubjectsVisit\/([0-9a-fA-F-]{36})$/
    );
    if (svMatch) {
      const subjectVisitId = svMatch[1];
      onSubjectVisitResponse(subjectVisitId, json.data);

      if (!pageState.currentSubjectVisitId) {
        pageState.currentSubjectVisitId = subjectVisitId;
      }
      const subj = json.data.subject;
      if (subj && subj.id) {
        pageState.currentSubjectId = subj.id;
      }
      scheduleInjection();
      return;
    }

    // /api/SubjectsForm/{id} пока не используем из перехвата
  }

  // -----------------------------------------------------
  // SPA route change
  // -----------------------------------------------------

  function onRouteChange() {
    const pathname = getPathname();
    const subjectId = parseSubjectIdFromUrl(pathname);
    const subjectVisitId = parseSubjectVisitIdFromUrl(pathname);

    if (subjectId) {
      pageState.currentSubjectId = subjectId;
    }

    if (subjectVisitId) {
      pageState.currentSubjectVisitId = subjectVisitId;
      const linkedSubject = subjectByVisit.get(subjectVisitId);
      if (linkedSubject) {
        pageState.currentSubjectId = linkedSubject;
      }
    }

    log(
      "Route changed:",
      pathname,
      "subjectId=",
      pageState.currentSubjectId,
      "subjectVisitId=",
      pageState.currentSubjectVisitId
    );

    scheduleInjection();
  }

  function scheduleInjection() {
    if (pageState.injectionScheduled) return;
    pageState.injectionScheduled = true;

    setTimeout(async () => {
      pageState.injectionScheduled = false;

      const { currentSubjectVisitId } = pageState;

      if (currentSubjectVisitId) {
        if (!pageState.currentSubjectId) {
          const subjId = subjectByVisit.get(currentSubjectVisitId);
          if (subjId) {
            pageState.currentSubjectId = subjId;
          } else {
            const sv = await ensureSubjectVisitLoaded(
              currentSubjectVisitId,
              getBaseUrl()
            );
            if (sv && sv.raw && sv.raw.subject && sv.raw.subject.id) {
              pageState.currentSubjectId = sv.raw.subject.id;
              subjectByVisit.set(currentSubjectVisitId, sv.raw.subject.id);
            }
          }
        }

        const { currentSubjectId } = pageState;

        if (!currentSubjectId) {
          log(
            "scanAndInjectForAllFields: no subjectId for current visit",
            currentSubjectVisitId
          );
          return;
        }

        await ensureLastVsHistoryLoaded(
          currentSubjectId,
          currentSubjectVisitId
        );

        injectHintsForCurrentForm();
      }
    }, 500);
  }

  (function patchHistoryApi() {
    const origPush = history.pushState;
    const origReplace = history.replaceState;

    history.pushState = function () {
      const ret = origPush.apply(this, arguments);
      onRouteChange();
      return ret;
    };

    history.replaceState = function () {
      const ret = origReplace.apply(this, arguments);
      onRouteChange();
      return ret;
    };

    window.addEventListener("popstate", () => {
      onRouteChange();
    });

    log("history API patched");
  })();

  // -------------------------------------------------
  // MutationObserver
  // -------------------------------------------------

  (function setupMutationObserver() {
    const root = document.querySelector("#root") || document.body;
    if (!root) return;

    const observer = new MutationObserver(() => {
      scheduleInjection();
    });

    observer.observe(root, {
      childList: true,
      subtree: true,
    });

    log("MutationObserver attached");

    onRouteChange();
  })();
})();
