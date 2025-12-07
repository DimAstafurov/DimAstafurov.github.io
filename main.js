// vs-helper.js
// ======================================================
// Работает на mis.ctcloud.ru (page context).
// 1) Перехватывает XHR, чтобы:
//    - вытащить Authorization Bearer токен;
//    - увидеть JSON форм /api/SubjectsForm/... (ЖВП).
// 2) Через fetch (с этим же токеном) подгружает:
//    - данные текущего визита;
//    - список всех визитов субъекта;
//    - формы ЖВП по предыдущим завершенным визитам.
// 3) Строит историю значений по каждому fieldKey.
// 4) Под каждым подходящим <input> показывает
//    последнюю запись и кнопку "История" с попапом.
// ======================================================

(() => {
  "use strict";

  if (window.__VS_HELPER_INITIALIZED__) return;
  window.__VS_HELPER_INITIALIZED__ = true;

  if (location.hostname !== "mis.ctcloud.ru") return;

  const logPrefix = "[VS Helper]";
  const DEBUG = true;

  function log(...args) {
    if (!DEBUG) return;
    console.log(logPrefix, ...args);
  }

  // ------------------------------------------------------
  // 1. Глобальное состояние
  // ------------------------------------------------------

  /** Последний увиденный Authorization: Bearer ... */
  let authHeaderValue = null;
  /** Колбэки, которые ждут появления authHeaderValue */
  const authReadyCallbacks = [];

  /** 
   * subjectId -> массив визитов:
   * [{ subjectVisitId, title, date, index, formCompletedStatus }, ...]
   */
  const visitsBySubjectId = new Map();

  /** subjectVisitId -> subjectId */
  const subjectIdByVisitId = new Map();

  /**
   * История по субъекту:
   * subjectId -> { [fieldKey]: MeasurementEntry[] }
   * MeasurementEntry: см. addMeasurementToHistory()
   */
  const vsHistoryBySubjectId = new Map();

  /** Для каких subjectId уже пытались загрузить прошлые визиты */
  const previousVsLoadedForSubject = new Set();

  // ------------------------------------------------------
  // 2. Утилиты
  // ------------------------------------------------------

  function safeJsonParse(text) {
    try {
      return JSON.parse(text);
    } catch (e) {
      log("JSON parse error:", e);
      return null;
    }
  }

  function getCurrentSubjectVisitIdFromLocation() {
    // Примеры:
    //   /subjectVisit/f56d907e-bd8a-429b-bd70-7d7fc4dd86ea
    //   /subjectVisit/cdeefbd9-afa0-4b8d-b307-4908d907ebe9/timePoints
    const m = location.pathname.match(/\/subjectVisit\/([^/]+)/i);
    return m ? m[1] : null;
  }

  function whenAuthReady(cb) {
    if (authHeaderValue) {
      cb(authHeaderValue);
    } else {
      authReadyCallbacks.push(cb);
    }
  }

  function notifyAuthReady() {
    if (!authHeaderValue) return;
    const callbacks = authReadyCallbacks.splice(0, authReadyCallbacks.length);
    callbacks.forEach((cb) => {
      try {
        cb(authHeaderValue);
      } catch (e) {
        console.error(logPrefix, "authReady callback error", e);
      }
    });
  }

  function getHistory(subjectId) {
    if (!subjectId) return null;
    let map = vsHistoryBySubjectId.get(subjectId);
    if (!map) {
      map = Object.create(null);
      vsHistoryBySubjectId.set(subjectId, map);
    }
    return map;
  }

  function addMeasurementToHistory(measurement) {
    const {
      subjectId,
      fieldKey,
      measuredAt,
      subjectVisitId,
      subjectVisitTitle,
      visitDate,
      sectionTitle,
      timePointLabel,
      value,
      unit
    } = measurement;

    if (!subjectId || !fieldKey) return;

    const history = getHistory(subjectId);
    if (!history) return;

    if (!history[fieldKey]) {
      history[fieldKey] = [];
    }

    const arr = history[fieldKey];

    // Не дублируем если точно такое же уже есть
    const exists = arr.some(
      (m) =>
        m.subjectVisitId === subjectVisitId &&
        m.sectionTitle === sectionTitle &&
        m.timePointLabel === timePointLabel &&
        m.value === value
    );
    if (exists) return;

    arr.push({
      subjectId,
      fieldKey,
      measuredAt: measuredAt || visitDate || null,
      subjectVisitId,
      subjectVisitTitle,
      visitDate,
      sectionTitle,
      timePointLabel,
      value,
      unit
    });

    // Сортировка по дате (новые сверху)
    arr.sort((a, b) => {
      const da = a.measuredAt || a.visitDate || "";
      const db = b.measuredAt || b.visitDate || "";
      if (da < db) return 1;
      if (da > db) return -1;
      return 0;
    });
  }

  function formatDateTimeShort(isoString) {
    if (!isoString) return "";
    const d = new Date(isoString);
    if (Number.isNaN(d.getTime())) return "";
    const dd = String(d.getDate()).padStart(2, "0");
    const mm = String(d.getMonth() + 1).padStart(2, "0");
    const yyyy = d.getFullYear();
    const hh = String(d.getHours()).padStart(2, "0");
    const mi = String(d.getMinutes()).padStart(2, "0");
    return `${dd}.${mm}.${yyyy} ${hh}:${mi}`;
  }

  // ------------------------------------------------------
  // 3. Парсинг JSON API
  // ------------------------------------------------------

  /**
   * Разбор /api/Subjects/{subjectId}
   */
  function handleSubjectsResponse(subjectId, json) {
    if (!json || !json.data) return;
    const data = json.data;
    const subjectVisitList = Array.isArray(data.subjectVisitList)
      ? data.subjectVisitList
      : [];

    const visits = subjectVisitList.map((sv) => {
      const visit = sv.visit || {};
      const vId = sv.id;
      const date = sv.date || null;
      const title = visit.title || "";
      const index = typeof visit.index === "number" ? visit.index : null;
      const status = sv.formCompletedStatus || null;

      // Запомним связь визит -> субъект
      const subjId =
        data.id ||
        sv.subjectId ||
        (sv.subject && sv.subject.id) ||
        null;
      if (subjId) {
        subjectIdByVisitId.set(vId, subjId);
      }

      return {
        subjectVisitId: vId,
        title,
        date,
        index,
        formCompletedStatus: status
      };
    });

    if (data.id) {
      visitsBySubjectId.set(data.id, visits);
      log("Stored visits for subject", data.id, visits);
    } else {
      log("Subjects response without subject id");
    }
  }

  /**
   * Разбор JSON формы ЖВП (SubjectsForm).
   * json ожидается формата: { message, data: { ... } }
   */
  function extractMeasurementsFromSubjectForm(json, context) {
    if (!json || !json.data) return;
    const sff = json.data;

    // Попробуем вытащить subjectVisitId и subjectId
    const subjectVisitId =
      context.subjectVisitId ||
      sff.subjectVisitId ||
      (sff.subjectVisit && sff.subjectVisit.id) ||
      getCurrentSubjectVisitIdFromLocation() ||
      null;

    const subjectId =
      context.subjectId ||
      (sff.subject && sff.subject.id) ||
      (subjectVisitId && subjectIdByVisitId.get(subjectVisitId)) ||
      null;

    const form = sff.form || {};
    const formTitle = form.title || "Жизненно-важные показатели";
    const formType = form.formType || form.formTypeDTO || {};
    const formTypeKey = formType.formTypeKey || formType.key || null;

    // Если это не VS-форма — выходим.
    if (
      formTypeKey !== "VS" &&
      !/жизненно-важные показатели/i.test(formTitle)
    ) {
      return;
    }

    const visitTitle = context.subjectVisitTitle || "";
    const visitDate = context.visitDate || null;

    // Попробуем вытащить «временную точку» из subjectTimePointList,
    // если она вообще есть.
    let globalTimePointLabel = null;
    if (Array.isArray(sff.subjectTimePointList) && sff.subjectTimePointList.length) {
      const tp = sff.subjectTimePointList[0];
      globalTimePointLabel =
        tp.timePointName ||
        tp.pointName ||
        tp.title ||
        tp.name ||
        tp.label ||
        null;
    }

    const fields = Array.isArray(sff.subjectFormFieldList)
      ? sff.subjectFormFieldList
      : [];

    fields.forEach((sf) => {
      const field = sf.field || sf.fieldDTO || {};
      const fieldKey = field.fieldKey || field.key || null;
      const fieldTitle = field.title || "";
      const rawValue = sf.value;
      const value =
        rawValue === null || rawValue === undefined ? null : String(rawValue).trim();

      if (!fieldKey || value === null || value === "") return;

      const unit =
        field.units ||
        field.unit ||
        (field.unitDTO && field.unitDTO.name) ||
        null;

      // Возможное поле с временем/датой измерения
      const measuredAt =
        sf.measuredAt ||
        sf.createdAt ||
        sff.date ||
        sff.createdAt ||
        null;

      // Если у поля есть спецификация временной точки — используем её.
      let timePointLabel = globalTimePointLabel;
      const tpId =
        sf.subjectTimePointId ||
        (sf.subjectTimePoint && sf.subjectTimePoint.id) ||
        null;
      if (tpId && Array.isArray(sff.subjectTimePointList)) {
        const tpObj = sff.subjectTimePointList.find((tp) => tp.id === tpId);
        if (tpObj) {
          timePointLabel =
            tpObj.timePointName ||
            tpObj.pointName ||
            tpObj.title ||
            tpObj.name ||
            tpObj.label ||
            timePointLabel;
        }
      }

      addMeasurementToHistory({
        subjectId,
        fieldKey,
        measuredAt,
        subjectVisitId,
        subjectVisitTitle: visitTitle,
        visitDate,
        sectionTitle: formTitle,
        timePointLabel,
        value,
        unit
      });
    });
  }

  // ------------------------------------------------------
  // 4. Загрузка контекста субъекта и прошлых визитов
  // ------------------------------------------------------

  /**
   * Загружаем:
   *   /api/SubjectsVisit/{currentVisitId} -> subjectId
   *   /api/Subjects/{subjectId} -> список визитов
   */
  async function ensureSubjectContextLoaded() {
    const currentVisitId = getCurrentSubjectVisitIdFromLocation();
    if (!currentVisitId) return;

    // Если subjectId по этому визиту уже известен и визиты уже загружены — выходим.
    const knownSubjectId = subjectIdByVisitId.get(currentVisitId);
    if (knownSubjectId && visitsBySubjectId.has(knownSubjectId)) {
      return;
    }

    if (!authHeaderValue) {
      log("No auth token yet, cannot load subject context");
      return;
    }

    const baseUrl = location.origin;

    // 1) /api/SubjectsVisit/{currentVisitId}
    const visitResp = await fetch(
      `${baseUrl}/api/SubjectsVisit/${encodeURIComponent(currentVisitId)}`,
      {
        method: "GET",
        headers: {
          Authorization: authHeaderValue,
          Accept: "application/json, text/plain, */*"
        },
        credentials: "include"
      }
    );

    const visitJson = safeJsonParse(await visitResp.text());
    if (!visitJson || !visitJson.data) {
      log("Failed to load current SubjectVisit");
      return;
    }

    const sv = visitJson.data;
    const subject =
      sv.subject ||
      sv.subjectDTO ||
      null;

    const subjectId =
      subject?.id ||
      sv.subjectId ||
      null;

    if (subjectId) {
      subjectIdByVisitId.set(currentVisitId, subjectId);
    } else {
      log("Cannot determine subjectId from SubjectsVisit");
      return;
    }

    // 2) /api/Subjects/{subjectId}
    const subjResp = await fetch(
      `${baseUrl}/api/Subjects/${encodeURIComponent(subjectId)}`,
      {
        method: "GET",
        headers: {
          Authorization: authHeaderValue,
          Accept: "application/json, text/plain, */*"
        },
        credentials: "include"
      }
    );

    const subjJson = safeJsonParse(await subjResp.text());
    handleSubjectsResponse(subjectId, subjJson);
  }

  /**
   * Загружает все формы ЖВП по предыдущим завершенным визитам
   * конкретного субъекта.
   */
  async function ensurePreviousVsLoadedForSubject(subjectId) {
    if (!subjectId) return;
    if (previousVsLoadedForSubject.has(subjectId)) return;
    if (!authHeaderValue) return;

    const visits = visitsBySubjectId.get(subjectId);
    if (!Array.isArray(visits) || !visits.length) return;

    const currentVisitId = getCurrentSubjectVisitIdFromLocation();

    // Найдем текущий визит чтобы знать дату/индекс
    const currentVisit = visits.find((v) => v.subjectVisitId === currentVisitId) || null;

    // Фильтруем "завершенные" визиты:
    //   - formCompletedStatus === "Completed"
    //   - и/или дата < дата текущего визита (если есть)
    const prevVisits = visits.filter((v) => {
      if (v.subjectVisitId === currentVisitId) return false;
      const isCompleted = v.formCompletedStatus === "Completed";
      if (!currentVisit || !currentVisit.date || !v.date) {
        return isCompleted;
      }
      return isCompleted && v.date < currentVisit.date;
    });

    if (!prevVisits.length) {
      previousVsLoadedForSubject.add(subjectId);
      return;
    }

    const baseUrl = location.origin;

    for (const v of prevVisits) {
      try {
        // /api/SubjectsVisit/{visitId} -> subjectFormList
        const resp = await fetch(
          `${baseUrl}/api/SubjectsVisit/${encodeURIComponent(v.subjectVisitId)}`,
          {
            method: "GET",
            headers: {
              Authorization: authHeaderValue,
              Accept: "application/json, text/plain, */*"
            },
            credentials: "include"
          }
        );
        const json = safeJsonParse(await resp.text());
        if (!json || !json.data) continue;

        const sv = json.data;
        const subjectFormList = Array.isArray(sv.subjectFormList)
          ? sv.subjectFormList
          : [];

        // Ищем формы ЖВП
        const vsForms = subjectFormList.filter((sf) => {
          const form = sf.form || sf.formDTO || {};
          const formType = form.formType || form.formTypeDTO || {};
          const formTypeKey = formType.formTypeKey || formType.key || null;
          const title = form.title || "";
          return (
            formTypeKey === "VS" ||
            /жизненно-важные показатели/i.test(title)
          );
        });

        for (const sf of vsForms) {
          const formId = sf.id || sf.subjectFormId;
          if (!formId) continue;

          const formResp = await fetch(
            `${baseUrl}/api/SubjectsForm/${encodeURIComponent(formId)}`,
            {
              method: "GET",
              headers: {
                Authorization: authHeaderValue,
                Accept: "application/json, text/plain, */*"
              },
              credentials: "include"
            }
          );
          const formJson = safeJsonParse(await formResp.text());

          extractMeasurementsFromSubjectForm(formJson, {
            subjectId,
            subjectVisitId: v.subjectVisitId,
            subjectVisitTitle: v.title || "",
            visitDate: v.date || null
          });
        }
      } catch (e) {
        console.error(logPrefix, "Error loading previous VS forms:", e);
      }
    }

    previousVsLoadedForSubject.add(subjectId);
  }

  // ------------------------------------------------------
  // 5. Перехват XHR (только наблюдение, не ломаем логику сайта)
  // ------------------------------------------------------

  (function installXhrHook() {
    const OriginalXHR = window.XMLHttpRequest;
    if (!OriginalXHR) return;

    function WrappedXHR() {
      const xhr = new OriginalXHR();

      // Сохраняем метод и url, чтобы в onload понимать что за запрос
      xhr.__vs_open = OriginalXHR.prototype.open;
      xhr.__vs_send = OriginalXHR.prototype.send;
      xhr.__vs_setRequestHeader = OriginalXHR.prototype.setRequestHeader;
      xhr.__vs_url = "";
      xhr.__vs_method = "";
      xhr.__vs_requestHeaders = {};

      xhr.open = function (method, url, async, user, password) {
        try {
          xhr.__vs_method = method;
          xhr.__vs_url = url;
        } catch (e) {
          // ignore
        }
        return xhr.__vs_open.call(this, method, url, async, user, password);
      };

      xhr.setRequestHeader = function (name, value) {
        try {
          xhr.__vs_requestHeaders[name.toLowerCase()] = value;
          if (name.toLowerCase() === "authorization" && value.startsWith("Bearer ")) {
            authHeaderValue = value;
            notifyAuthReady();
          }
        } catch (e) {
          // ignore
        }
        return xhr.__vs_setRequestHeader.call(this, name, value);
      };

      xhr.addEventListener("load", function () {
        try {
          const url = xhr.__vs_url || "";
          const method = (xhr.__vs_method || "GET").toUpperCase();

          if (!url || method !== "GET") return;
          if (!xhr.responseText) return;

          // Приводим к абсолютному URL, чтобы проще матчить.
          const absUrl = new URL(url, location.origin).toString();

          // 1) /api/Subjects/{subjectId}
          const mSubjects = absUrl.match(/\/api\/Subjects\/([^/?#]+)/i);
          if (mSubjects) {
            const subjectId = mSubjects[1];
            const json = safeJsonParse(xhr.responseText);
            handleSubjectsResponse(subjectId, json);
            return;
          }

          // 2) /api/SubjectsForm/{id} (форма ЖВП текущего визита)
          const mForm = absUrl.match(/\/api\/SubjectsForm\/([^/?#]+)/i);
          if (mForm) {
            const json = safeJsonParse(xhr.responseText);
            extractMeasurementsFromSubjectForm(json, {});
            return;
          }

          // Остальное можно игнорировать.
        } catch (e) {
          console.error(logPrefix, "XHR load handler error", e);
        }
      });

      return xhr;
    }

    // Копируем статические свойства, чтобы не сломать сторонний код.
    for (const key in OriginalXHR) {
      if (Object.prototype.hasOwnProperty.call(OriginalXHR, key)) {
        WrappedXHR[key] = OriginalXHR[key];
      }
    }

    window.XMLHttpRequest = WrappedXHR;

    log("XHR hook installed");
  })();

  // ------------------------------------------------------
  // 6. UI: подсказка под инпутом + попап с историей
  // ------------------------------------------------------

  /**
   * Вставляет под конкретный input маленький блок с последним значением
   * и кнопкой "История".
   */
  function injectHistoryUIForField(inputEl, fieldKey, fieldTitle, subjectId, currentVisitId) {
    if (!inputEl || !fieldKey || !subjectId) return;

    const history = getHistory(subjectId);
    if (!history) return;

    const allEntries = history[fieldKey] || [];
    if (!allEntries.length) return;

    // Отфильтруем только предыдущие визиты
    const previousOnly = allEntries.filter(
      (e) => e.subjectVisitId && e.subjectVisitId !== currentVisitId
    );
    if (!previousOnly.length) return;

    const latestPrev = previousOnly[0];

    // Родительский контейнер вокруг инпута — ищем MUI-обертки.
    const wrapper =
      inputEl.closest(
        ".MuiFormControl-root, .MuiFormGroup-root, .MuiFormControlLabel-root, .MuiGrid-item"
      ) || inputEl.parentElement;

    if (!wrapper) return;

    // Обеспечим локальный контекст для абсолютного позиционирования попапа.
    if (getComputedStyle(wrapper).position === "static") {
      wrapper.style.position = "relative";
    }

    // Если под этим полем уже есть наш блок — переиспользуем.
    let historyContainer = wrapper.querySelector(".vs-history-container");
    if (!historyContainer) {
      historyContainer = document.createElement("div");
      historyContainer.className = "vs-history-container";

      if (inputEl.nextSibling) {
        wrapper.insertBefore(historyContainer, inputEl.nextSibling);
      } else {
        wrapper.appendChild(historyContainer);
      }
    } else {
      historyContainer.innerHTML = "";
    }

    // --- Короткая подпись с последним значением ---
    const latestLine = document.createElement("div");
    latestLine.className = "vs-history-latest";

    const visitPart = latestPrev.subjectVisitTitle
      ? `визит: ${latestPrev.subjectVisitTitle}`
      : "";
    const sectionPart = latestPrev.sectionTitle
      ? `секция: ${latestPrev.sectionTitle}`
      : "";
    const timePointPart = latestPrev.timePointLabel
      ? `точка: ${latestPrev.timePointLabel}`
      : "";
    const datePart = latestPrev.measuredAt
      ? `(${formatDateTimeShort(latestPrev.measuredAt)})`
      : latestPrev.visitDate
        ? `(${formatDateTimeShort(latestPrev.visitDate)})`
        : "";

    const metaParts = [visitPart, sectionPart, timePointPart].filter(Boolean);
    const metaText = metaParts.length ? `, ${metaParts.join(", ")}` : "";

    latestLine.textContent =
      `Предыдущее: ${latestPrev.value}` +
      (latestPrev.unit ? ` ${latestPrev.unit}` : "") +
      metaText +
      (datePart ? ` ${datePart}` : "");

    // --- Кнопка "История" ---
    const toggleBtn = document.createElement("button");
    toggleBtn.type = "button";
    toggleBtn.className = "vs-history-toggle-btn";
    toggleBtn.textContent = "История";

    // --- Попап со всей историей ---
    const popup = document.createElement("div");
    popup.className = "vs-history-popup";
    popup.style.display = "none";

    const titleEl = document.createElement("div");
    titleEl.className = "vs-history-popup-title";
    titleEl.textContent = fieldTitle || fieldKey || "Поле";

    popup.appendChild(titleEl);

    previousOnly.forEach((entry) => {
      const row = document.createElement("div");
      row.className = "vs-history-popup-row";

      const left = document.createElement("div");
      left.className = "vs-history-popup-row-main";
      left.textContent =
        `${entry.value}` + (entry.unit ? ` ${entry.unit}` : "");

      const right = document.createElement("div");
      right.className = "vs-history-popup-row-meta";

      const parts = [];
      if (entry.subjectVisitTitle) parts.push(entry.subjectVisitTitle);
      if (entry.sectionTitle) parts.push(entry.sectionTitle);
      if (entry.timePointLabel) parts.push(entry.timePointLabel);
      const meta = parts.join(" · ");

      const dateStr =
        entry.measuredAt || entry.visitDate
          ? formatDateTimeShort(entry.measuredAt || entry.visitDate)
          : "";

      right.textContent = [meta, dateStr].filter(Boolean).join(" • ");

      row.appendChild(left);
      row.appendChild(right);
      popup.appendChild(row);
    });

    historyContainer.appendChild(latestLine);
    historyContainer.appendChild(toggleBtn);
    historyContainer.appendChild(popup);

    // Логика открытия/закрытия попапа
    let opened = false;

    function setOpened(value) {
      opened = value;
      popup.style.display = opened ? "block" : "none";
    }

    toggleBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      setOpened(!opened);
    });

    // По клику вне попапа закрываем его
    document.addEventListener(
      "click",
      (e) => {
        if (!opened) return;
        if (
          !popup.contains(e.target) &&
          !toggleBtn.contains(e.target)
        ) {
          setOpened(false);
        }
      },
      { capture: true }
    );
  }

  /**
   * Ищем все инпуты формы, смотрим их fieldKey,
   * и если в истории для этого субъекта что-то есть —
   * подставляем UI.
   */
  function scanAndInjectForAllFields() {
    const subjectVisitId = getCurrentSubjectVisitIdFromLocation();
    const subjectId = subjectVisitId && subjectIdByVisitId.get(subjectVisitId);
    if (!subjectId) return;

    const history = getHistory(subjectId);
    if (!history) return;

    const currentVisitId = subjectVisitId;

    const knownFieldKeys = new Set(Object.keys(history));

    // Типичные варианты:
    //  - [data-annotation-key="SAD"] внутри MUI-оберток
    //  - <input data-annotation-key="SAD">
    //  - <input name="SAD">
    const selectorParts = [];
    knownFieldKeys.forEach((fk) => {
      selectorParts.push(
        `[data-annotation-key="${fk}"] input`,
        `input[data-annotation-key="${fk}"]`,
        `input[name="${fk}"]`
      );
    });
    if (!selectorParts.length) return;

    const inputs = document.querySelectorAll(selectorParts.join(","));
    inputs.forEach((inputEl) => {
      if (!inputEl || inputEl.__vsHistoryInjected) return;
      const fieldKey =
        inputEl.getAttribute("data-annotation-key") ||
        inputEl.name ||
        null;
      if (!fieldKey || !history[fieldKey]) return;

      // Попробуем вытянуть подпись поля (label) из DOM
      let fieldTitle = fieldKey;
      const labelEl =
        inputEl.closest(".MuiFormControl-root")?.querySelector("label") ||
        inputEl.closest(".MuiFormControl-root")?.querySelector(
          ".MuiFormLabel-root"
        );
      if (labelEl && labelEl.textContent) {
        fieldTitle = labelEl.textContent.trim();
      }

      injectHistoryUIForField(inputEl, fieldKey, fieldTitle, subjectId, currentVisitId);
      inputEl.__vsHistoryInjected = true;
    });
  }

  /**
   * MutationObserver: реагируем на появление формы/инпутов.
   */
  function setupMutationObserver() {
    const observer = new MutationObserver(() => {
      try {
        scanAndInjectForAllFields();
      } catch (e) {
        console.error(logPrefix, "MutationObserver error", e);
      }
    });

    observer.observe(document.documentElement, {
      childList: true,
      subtree: true
    });

    // И один стартовый прогон
    setTimeout(scanAndInjectForAllFields, 2000);
  }

  // ------------------------------------------------------
  // 7. Инициализация
  // ------------------------------------------------------

  // Как только появится authHeaderValue — грузим контекст субъекта.
  whenAuthReady(() => {
    ensureSubjectContextLoaded()
      .then(() => {
        const currentVisitId = getCurrentSubjectVisitIdFromLocation();
        const subjectId = currentVisitId && subjectIdByVisitId.get(currentVisitId);
        if (subjectId) {
          // Подгружаем данные прошлых визитов (ЖВП)
          ensurePreviousVsLoadedForSubject(subjectId).then(() => {
            // После подгрузки есть смысл обновить UI
            scanAndInjectForAllFields();
          });
        }
      })
      .catch((e) => {
        console.error(logPrefix, "Failed to ensure subject context", e);
      });
  });

  // Стартуем наблюдение за DOM
  setupMutationObserver();

  log("VS Helper initialized");
})();
