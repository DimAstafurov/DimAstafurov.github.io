// vs-helper.js
// ===============================================================
// Клиентский помощник для формы "Жизненно-важные показатели" (VS)
// ---------------------------------------------------------------
// - Перехватывает XHR, чтобы:
//   * вытащить токен Authorization (Bearer ...)
//   * вытащить список визитов субъекта (Subjects/{id})
//   * вытащить маппинг subjectVisitId -> subjectId (SubjectsVisit/{id})
// - По этим данным:
//   * находит предыдущие визиты текущего субъекта
//   * загружает по ним формы "Жизненно-важные показатели"
//   * собирает историю измерений по полям (SAD, DAD, HR и т.д.)
// - В DOM:
//   * ищет инпуты с соответствующими fieldKey (по data-annotation-key / name)
//   * под каждым инпутом показывает последнюю (предыдущую) величину
//   * даёт кнопку "История" с раскрывающимся списком всех прошлых значений
//
// Важно:
//   - Никаких запросов через сервер-прокси — всё из клиента, к тому же origin.
//   - URL у формы визита не меняется между секциями, поэтому нужен MutationObserver,
//     а также отслеживание history.pushState/replaceState + периодический опрос.
//
// Логи ищем в консоли по префиксу: [VS Helper]
// ===============================================================

(function () {
  "use strict";

  const logPrefix = "[VS Helper]";
  const VS_FORM_TYPE_KEY = "VS";

  /** Токен авторизации (значение заголовка Authorization) */
  let authHeaderValue = null;

  /**
   * subjectIdByVisitId:
   *   ключ: subjectVisitId (GUID визита субъекта)
   *   значение: subjectId (GUID субъекта)
   */
  const subjectIdByVisitId = new Map();

  /**
   * visitsBySubjectId:
   *   ключ: subjectId
   *   значение: массив визитов субъекта:
   *   {
   *     subjectVisitId: string,
   *     title: string,
   *     date: string | null (ISO),
   *     formCompletedStatus: string
   *   }
   */
  const visitsBySubjectId = new Map();

  /**
   * measurementHistory:
   *   ключ: subjectId
   *   значение: объект { [fieldKey: string]: Array<HistoryEntry> }
   *
   * HistoryEntry:
   *  {
   *    fieldKey: string,
   *    value: string | number,
   *    visitId: string | null,
   *    visitTitle: string,
   *    sectionTitle: string,
   *    timePoint: string | null,
   *    visitDate: string | null
   *  }
   */
  const measurementHistory = new Map();

  /**
   * previousVsLoadedForSubject:
   *   множество subjectId, для которых мы уже один раз сходили
   *   за предыдущими визитами и VS-формами.
   */
  const previousVsLoadedForSubject = new Set();

  /** Для деконфликта многократных перезапусков скана DOM */
  let scanScheduled = false;

  /** Для отслеживания смены URL (SPA-навигация) */
  let lastLocationHref = location.href;

  // ---------------------------------------------------------------
  // Базовые утилиты
  // ---------------------------------------------------------------

  function log() {
    try {
      const args = Array.prototype.slice.call(arguments);
      args.unshift(logPrefix);
      console.log.apply(console, args);
    } catch (e) {
      // молча проглатываем, если в консоль нельзя писать
    }
  }

  function safeJsonParse(text) {
    try {
      return JSON.parse(text);
    } catch {
      return null;
    }
  }

  /**
   * Извлекаем GUID визита субъекта из URL вида /subjectVisit/{id}
   */
  function getCurrentSubjectVisitIdFromLocation() {
    const m = location.pathname.match(
      /\/subjectVisit\/([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})/
    );
    return m ? m[1] : null;
  }

  /**
   * Получить (или создать) объект истории для конкретного субъекта
   */
  function getOrCreateSubjectHistory(subjectId) {
    let h = measurementHistory.get(subjectId);
    if (!h) {
      h = {};
      measurementHistory.set(subjectId, h);
    }
    return h;
  }

  function getHistory(subjectId) {
    return measurementHistory.get(subjectId) || null;
  }

  // ---------------------------------------------------------------
  // Перехват XHR: токен + данные о визитах и формах
  // ---------------------------------------------------------------

  function installXhrHook() {
    if (!window.XMLHttpRequest) {
      log("XMLHttpRequest not found, cannot install hook");
      return;
    }

    const origOpen = XMLHttpRequest.prototype.open;
    const origSend = XMLHttpRequest.prototype.send;
    const origSetRequestHeader = XMLHttpRequest.prototype.setRequestHeader;

    // Ловим Authorization
    XMLHttpRequest.prototype.setRequestHeader = function (name, value) {
      try {
        if (
          typeof name === "string" &&
          name.toLowerCase() === "authorization" &&
          typeof value === "string" &&
          value.toLowerCase().startsWith("bearer")
        ) {
          authHeaderValue = value;
          log("Captured Authorization header");
        }
      } catch (e) {
        console.error(logPrefix, "Error in setRequestHeader hook:", e);
      }
      return origSetRequestHeader.apply(this, arguments);
    };

    // Запоминаем URL
    XMLHttpRequest.prototype.open = function (method, url) {
      this.__vs_url = url;
      return origOpen.apply(this, arguments);
    };

    // Анализируем ответ
    XMLHttpRequest.prototype.send = function (body) {
      this.addEventListener("load", function () {
        try {
          const url = this.__vs_url || "";
          if (!url) return;

          // интересуют только текстовые ответы
          if (this.responseType && this.responseType !== "" && this.responseType !== "text") {
            return;
          }

          const text = this.responseText;
          if (!text) return;

          const json = safeJsonParse(text);
          if (!json) return;

          // /api/Subjects/{guid} -> список визитов субъекта
          if (/\/api\/Subjects\/[0-9a-fA-F-]{36}/.test(url)) {
            handleSubjectResponse(json);
          }

          // /api/SubjectsVisit/{guid} -> данные по конкретному визиту субъекта
          if (/\/api\/SubjectsVisit\/[0-9a-fA-F-]{36}/.test(url)) {
            handleSubjectsVisitResponse(json, url);
          }

          // /api/SubjectsForm/{guid} -> данные по конкретной форме
          if (/\/api\/SubjectsForm\/[0-9a-fA-F-]{36}/.test(url)) {
            handleSubjectsFormResponse(json, url);
          }
        } catch (e) {
          console.error(logPrefix, "Error in XHR load handler:", e);
        }
      });

      return origSend.apply(this, arguments);
    };

    log("XHR hook installed");
  }

  /**
   * Обработка ответа /api/Subjects/{subjectId}
   * Из него вытаскиваем:
   *  - сам subjectId
   *  - subjectVisitList -> список визитов, статус, дата
   */
  function handleSubjectResponse(json) {
    if (!json || !json.data) return;
    const data = json.data;
    const subjectId = data.id;
    if (!subjectId) return;

    const subjectVisitList = Array.isArray(data.subjectVisitList)
      ? data.subjectVisitList
      : [];

    const visits = subjectVisitList.map((sv) => {
      return {
        subjectVisitId: sv.id,
        title: sv.visit && sv.visit.title ? sv.visit.title : "",
        date: sv.date || null,
        formCompletedStatus: sv.formCompletedStatus || ""
      };
    });

    visitsBySubjectId.set(subjectId, visits);
    subjectVisitList.forEach((sv) => {
      if (sv.id) {
        subjectIdByVisitId.set(sv.id, subjectId);
      }
    });

    log("Stored visits for subject", subjectId, visits);

    // Если мы уже на странице subjectVisit/{id} этого субъекта —
    // можно сразу инициировать загрузку прошлых визитов
    const currentVisitId = getCurrentSubjectVisitIdFromLocation();
    if (currentVisitId && subjectIdByVisitId.get(currentVisitId) === subjectId) {
      ensurePreviousVsLoadedForSubject(subjectId).then(() => {
        triggerScanSoon();
      });
    }
  }

  /**
   * Обработка /api/SubjectsVisit/{subjectVisitId} (XHR)
   * Тут мы:
   *  - вытаскиваем subjectId
   *  - мапим subjectVisitId -> subjectId
   *  - добавляем визит в visitsBySubjectId (чтобы что-то было даже до /api/Subjects/{id})
   */
  function handleSubjectsVisitResponse(json, url) {
    if (!json || !json.data) return;

    const sv = json.data;
    const subjectVisitId =
      sv.id ||
      (url.match(/\/api\/SubjectsVisit\/([0-9a-fA-F-]{36})/) || [])[1] ||
      null;

    const subject =
      sv.subject ||
      sv.subjectDTO ||
      null;

    const subjectId =
      (subject && subject.id) ||
      sv.subjectId ||
      null;

    if (!subjectVisitId || !subjectId) {
      log(
        "handleSubjectsVisitResponse: cannot resolve subjectVisitId/subjectId",
        "subjectVisitId=",
        subjectVisitId,
        "subjectId=",
        subjectId
      );
      return;
    }

    subjectIdByVisitId.set(subjectVisitId, subjectId);

    // minimally заполним visitsBySubjectId, чтобы не было пусто
    const arr = visitsBySubjectId.get(subjectId) || [];
    const exists = arr.some((v) => v.subjectVisitId === subjectVisitId);
    if (!exists) {
      arr.push({
        subjectVisitId,
        title: sv.visit && sv.visit.title ? sv.visit.title : "",
        date: sv.date || null,
        formCompletedStatus: sv.formCompletedStatus || ""
      });
      visitsBySubjectId.set(subjectId, arr);
    }

    log(
      "handleSubjectsVisitResponse: mapped visit",
      subjectVisitId,
      "-> subject",
      subjectId,
      "visits now:",
      arr
    );

    // На всякий случай — если это текущий визит, можно дернуть обеспечение предыдущих
    const currentVisitId = getCurrentSubjectVisitIdFromLocation();
    if (currentVisitId === subjectVisitId) {
      ensurePreviousVsLoadedForSubject(subjectId).then(() => {
        triggerScanSoon();
      });
    }
  }

  /**
   * Обработка ответа /api/SubjectsForm/{formId}
   * Если это VS-форма, вытаскиваем измерения.
   */
  function handleSubjectsFormResponse(json, url) {
    if (!json || !json.data) return;
    const sf = json.data;

    const form = sf.form || sf.formDTO || {};
    const formType = form.formType || form.formTypeDTO || {};
    const formTypeKey = formType.formTypeKey || formType.key || null;
    const title = form.title || "";

    const isVs =
      formTypeKey === VS_FORM_TYPE_KEY ||
      /жизненно-важные показатели/i.test(title);

    if (!isVs) {
      return;
    }

    const subjectVisitId =
      sf.subjectVisitId ||
      (sf.subjectVisit && sf.subjectVisit.id) ||
      null;

    const subjectId =
      subjectVisitId && subjectIdByVisitId.get(subjectVisitId);

    const visitTitle =
      (sf.subjectVisit &&
        sf.subjectVisit.visit &&
        sf.subjectVisit.visit.title) ||
      (sf.subjectVisit && sf.subjectVisit.title) ||
      "";

    const visitDate =
      (sf.subjectVisit && sf.subjectVisit.date) || null;

    if (!subjectId) {
      log(
        "SubjectsForm (VS) but no subjectId mapping yet. visitId =",
        subjectVisitId
      );
    }

    extractMeasurementsFromSubjectForm(json, {
      subjectId: subjectId || null,
      subjectVisitId,
      subjectVisitTitle: visitTitle,
      visitDate
    });

    if (subjectId) {
      triggerScanSoon();
    }
  }

  // ---------------------------------------------------------------
  // Загрузка визитов и прошлых VS-форм (самостоятельные fetch)
  // ---------------------------------------------------------------

  /**
   * Убедиться, что в visitsBySubjectId для subjectId есть полный список визитов.
   * Если ничего (или только один визит) — тянем /api/Subjects/{subjectId}.
   */
  async function ensureVisitsLoadedForSubject(subjectId) {
    const existing = visitsBySubjectId.get(subjectId);
    if (Array.isArray(existing) && existing.length > 1) {
      // уже что-то внятное есть, не трогаем
      return;
    }

    if (!authHeaderValue) {
      log("ensureVisitsLoadedForSubject: no authHeaderValue, cannot fetch");
      return;
    }

    const baseUrl = location.origin;

    try {
      log("ensureVisitsLoadedForSubject: fetching /api/Subjects/", subjectId);
      const resp = await fetch(
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

      const text = await resp.text();
      const json = safeJsonParse(text);
      if (!json) {
        log("ensureVisitsLoadedForSubject: invalid JSON for subject", subjectId);
        return;
      }

      handleSubjectResponse(json);
    } catch (e) {
      console.error(
        logPrefix,
        "ensureVisitsLoadedForSubject: error fetching subject",
        subjectId,
        e
      );
    }
  }

  /**
   * ВАЖНОЕ ИЗМЕНЕНИЕ:
   * - Перед поиском предыдущих визитов обязательно вызываем ensureVisitsLoadedForSubject.
   * - Мягкий фильтр прошлых визитов:
   *   * исключаем текущий визит
   *   * исключаем явно пустые ("Empty")
   *   * если есть даты — берём только те, что раньше текущего по дате
   */
  async function ensurePreviousVsLoadedForSubject(subjectId) {
    log("ensurePreviousVsLoadedForSubject: start for subject", subjectId);
    if (!subjectId) {
      log("ensurePreviousVsLoadedForSubject: no subjectId, exit");
      return;
    }
    if (previousVsLoadedForSubject.has(subjectId)) {
      log("ensurePreviousVsLoadedForSubject: already loaded for", subjectId);
      return;
    }
    if (!authHeaderValue) {
      log("ensurePreviousVsLoadedForSubject: no authHeaderValue yet");
      return;
    }

    // сначала гарантируем, что список визитов подтянут
    await ensureVisitsLoadedForSubject(subjectId);

    const visits = visitsBySubjectId.get(subjectId);
    log("ensurePreviousVsLoadedForSubject: visits for subject", subjectId, visits);

    if (!Array.isArray(visits) || !visits.length) {
      log("ensurePreviousVsLoadedForSubject: no visits, exit");
      return;
    }

    const currentVisitId = getCurrentSubjectVisitIdFromLocation();
    const currentVisit =
      visits.find((v) => v.subjectVisitId === currentVisitId) || null;

    // Новый фильтр прошлых визитов
    const prevVisits = visits.filter((v) => {
      if (v.subjectVisitId === currentVisitId) return false;

      const status = (v.formCompletedStatus || "").toLowerCase();
      const notEmpty = status !== "empty";

      if (!currentVisit || !currentVisit.date || !v.date) {
        // если нет информации по датам — берём все не Empty
        return notEmpty;
      }

      return notEmpty && v.date < currentVisit.date;
    });

    log("ensurePreviousVsLoadedForSubject: previous visits to load", prevVisits);

    if (!prevVisits.length) {
      log("ensurePreviousVsLoadedForSubject: no previous visits, mark done");
      previousVsLoadedForSubject.add(subjectId);
      return;
    }

    const baseUrl = location.origin;

    for (const v of prevVisits) {
      try {
        log("Loading SubjectVisit", v.subjectVisitId);
        const resp = await fetch(
          `${baseUrl}/api/SubjectsVisit/${encodeURIComponent(
            v.subjectVisitId
          )}`,
          {
            method: "GET",
            headers: {
              Authorization: authHeaderValue,
              Accept: "application/json, text/plain, */*"
            },
            credentials: "include"
          }
        );

        const text = await resp.text();
        const json = safeJsonParse(text);
        if (!json || !json.data) {
          log("SubjectsVisit response without data for", v.subjectVisitId);
          continue;
        }

        const sv = json.data;
        const subjectFormList = Array.isArray(sv.subjectFormList)
          ? sv.subjectFormList
          : [];

        log(
          "SubjectVisit has",
          subjectFormList.length,
          "forms for visit",
          v.subjectVisitId
        );

        // Ищем VS-формы по formTypeKey==='VS' или по названию
        const vsForms = subjectFormList.filter((sf) => {
          const form = sf.form || sf.formDTO || {};
          const formType = form.formType || form.formTypeDTO || {};
          const formTypeKey =
            formType.formTypeKey || formType.key || null;
          const title = form.title || "";
          const isVs =
            formTypeKey === VS_FORM_TYPE_KEY ||
            /жизненно-важные показатели/i.test(title);

          if (isVs) {
            log(
              "Found VS form in previous visit",
              v.subjectVisitId,
              "form title:",
              title
            );
          }
          return isVs;
        });

        for (const sf of vsForms) {
          const formId = sf.id || sf.subjectFormId;
          if (!formId) continue;

          log("Loading SubjectsForm (VS) from previous visit", formId);
          const formResp = await fetch(
            `${baseUrl}/api/SubjectsForm/${encodeURIComponent(
              formId
            )}`,
            {
              method: "GET",
              headers: {
                Authorization: authHeaderValue,
                Accept: "application/json, text/plain, */*"
              },
              credentials: "include"
            }
          );

          const formText = await formResp.text();
          const formJson = safeJsonParse(formText);

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
    log("ensurePreviousVsLoadedForSubject: done for", subjectId);
  }

  // ---------------------------------------------------------------
  // Разбор SubjectForm и накопление истории измерений
  // ---------------------------------------------------------------

  /**
   * Разбираем структуру SubjectForm и записываем значения в measurementHistory
   * context:
   *  - subjectId: GUID субъекта
   *  - subjectVisitId: GUID визита субъекта
   *  - subjectVisitTitle: заголовок визита
   *  - visitDate: дата визита (ISO)
   */
  function extractMeasurementsFromSubjectForm(json, context) {
    if (!json || !json.data) return;

    const sf = json.data;
    const subjectId = context.subjectId;
    if (!subjectId) {
      log(
        "extractMeasurementsFromSubjectForm: no subjectId in context, skip",
        context
      );
      return;
    }

    const history = getOrCreateSubjectHistory(subjectId);

    const form = sf.form || sf.formDTO || {};
    const sectionTitle = form.title || "";

    const timePoint =
      sf.timePointTitle ||
      sf.timePoint ||
      (sf.timePointId ? String(sf.timePointId) : null);

    const visitDate = context.visitDate || sf.date || sf.formDate || null;

    // Пытаемся найти список полей с значениями
    const fields = Array.isArray(sf.subjectFieldList)
      ? sf.subjectFieldList
      : Array.isArray(sf.fieldValueList)
      ? sf.fieldValueList
      : [];

    log(
      "extractMeasurementsFromSubjectForm: parsing",
      fields.length,
      "fields for subject",
      subjectId,
      "visit",
      context.subjectVisitId
    );

    fields.forEach((f) => {
      const field = f.field || f.fieldDTO || {};
      const fieldKey =
        field.fieldKey || field.key || f.fieldKey || null;
      if (!fieldKey) return;

      const rawValue =
        f.value ??
        f.fieldValue ??
        f.numberValue ??
        f.stringValue ??
        null;

      if (rawValue === null || rawValue === "") return;

      const entry = {
        fieldKey,
        value: rawValue,
        visitId: context.subjectVisitId || null,
        visitTitle: context.subjectVisitTitle || "",
        sectionTitle,
        timePoint,
        visitDate
      };

      if (!history[fieldKey]) history[fieldKey] = [];
      history[fieldKey].push(entry);
    });

    // сортируем каждое поле по дате визита (новое -> старое)
    Object.keys(history).forEach((fk) => {
      history[fk].sort((a, b) => {
        if (a.visitDate && b.visitDate) {
          if (a.visitDate < b.visitDate) return 1;
          if (a.visitDate > b.visitDate) return -1;
        }
        return 0;
      });
    });

    log(
      "extractMeasurementsFromSubjectForm: updated history keys for subject",
      subjectId,
      Object.keys(history)
    );
  }

  // ---------------------------------------------------------------
  // DOM: поиск инпутов и отрисовка подсказок
  // ---------------------------------------------------------------

  function triggerScanSoon() {
    if (scanScheduled) return;
    scanScheduled = true;
    setTimeout(() => {
      scanScheduled = false;
      try {
        scanAndInjectForAllFields();
      } catch (e) {
        console.error(logPrefix, "Error in scanAndInjectForAllFields:", e);
      }
    }, 300);
  }

  /**
   * Обход всех известных fieldKey и попытка найти соответствующие им инпуты.
   * Ищем по:
   *  - data-annotation-key="{fieldKey}"
   *  - input[data-annotation-key="{fieldKey}"]
   *  - input[name="{fieldKey}"]
   */
  function scanAndInjectForAllFields() {
    const subjectVisitId = getCurrentSubjectVisitIdFromLocation();
    const subjectId =
      subjectVisitId && subjectIdByVisitId.get(subjectVisitId);

    if (!subjectId) {
      log(
        "scanAndInjectForAllFields: no subjectId for current visit",
        subjectVisitId
      );
      return;
    }

    const history = getHistory(subjectId);
    if (!history) {
      log("scanAndInjectForAllFields: no history map for subject", subjectId);
      return;
    }

    const currentVisitId = subjectVisitId;
    const fieldKeys = Object.keys(history);
    if (!fieldKeys.length) {
      log("scanAndInjectForAllFields: history is empty for subject", subjectId);
      return;
    }

    log("scanAndInjectForAllFields: fieldKeys with history", fieldKeys);

    const selectorParts = [];
    fieldKeys.forEach((fk) => {
      selectorParts.push(
        `[data-annotation-key="${fk}"] input`,
        `input[data-annotation-key="${fk}"]`,
        `input[name="${fk}"]`
      );
    });

    const selector = selectorParts.join(",");
    const inputs = document.querySelectorAll(selector);

    log(
      "scanAndInjectForAllFields: found",
      inputs.length,
      "inputs for keys",
      fieldKeys
    );

    inputs.forEach((inputEl) => {
      if (!inputEl || inputEl.__vsHistoryInjected) return;

      const fieldKey =
        inputEl.getAttribute("data-annotation-key") ||
        inputEl.name ||
        null;
      if (!fieldKey || !history[fieldKey]) return;

      // Имя поля для отображения (пытаемся взять label)
      let fieldTitle = fieldKey;
      const labelEl =
        inputEl.closest(".MuiFormControl-root")?.querySelector("label") ||
        inputEl
          .closest(".MuiFormControl-root")
          ?.querySelector(".MuiFormLabel-root");
      if (labelEl && labelEl.textContent) {
        fieldTitle = labelEl.textContent.trim();
      }

      log(
        "scanAndInjectForAllFields: injecting history UI for fieldKey",
        fieldKey,
        "title:",
        fieldTitle
      );

      injectHistoryUIForField(
        inputEl,
        fieldKey,
        fieldTitle,
        subjectId,
        currentVisitId
      );
      inputEl.__vsHistoryInjected = true;
    });
  }

  /**
   * Создаём UI под конкретным инпутом:
   *  - "Предыдущее: ..."
   *  - кнопка "История" с попапом
   */
  function injectHistoryUIForField(
    inputEl,
    fieldKey,
    fieldTitle,
    subjectId,
    currentVisitId
  ) {
    const history = getHistory(subjectId);
    if (!history || !history[fieldKey] || !history[fieldKey].length) {
      log(
        "injectHistoryUIForField: no history for fieldKey",
        fieldKey,
        "subject",
        subjectId
      );
      return;
    }

    // Берём только прошлые визиты (не текущий)
    const prevEntries = history[fieldKey].filter(
      (e) => e.visitId && e.visitId !== currentVisitId
    );
    if (!prevEntries.length) {
      log(
        "injectHistoryUIForField: no previous entries for fieldKey",
        fieldKey
      );
      return;
    }

    const last = prevEntries[0]; // уже отсортировано: [новые -> старые]

    const formControl =
      inputEl.closest(".MuiFormControl-root") || inputEl.parentElement;
    if (!formControl) {
      log(
        "injectHistoryUIForField: cannot find formControl for fieldKey",
        fieldKey
      );
      return;
    }

    let host = formControl.querySelector(".vs-helper-field-info");
    if (!host) {
      host = document.createElement("div");
      host.className = "vs-helper-field-info";
      formControl.appendChild(host);
    }

    // Перерисовываем содержимое, чтобы избежать дублей
    host.innerHTML = "";

    const lastLine = document.createElement("div");
    lastLine.className = "vs-helper-last-value";
    lastLine.textContent = buildLastLineText(fieldTitle, last);
    host.appendChild(lastLine);

    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "vs-helper-history-btn";
    btn.textContent = "История";

    const popup = buildHistoryPopup(fieldTitle, prevEntries);
    popup.style.display = "none";

    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      popup.style.display = popup.style.display === "none" ? "block" : "none";
    });

    host.appendChild(btn);
    host.appendChild(popup);
  }

  function buildLastLineText(fieldTitle, entry) {
    const parts = [];

    parts.push(`${fieldTitle}: ${entry.value}`);

    if (entry.visitTitle) {
      parts.push(entry.visitTitle);
    }

    if (entry.timePoint) {
      parts.push(`ТП: ${entry.timePoint}`);
    }

    if (entry.visitDate) {
      const d = new Date(entry.visitDate);
      if (!isNaN(d.getTime())) {
        const ds = d.toLocaleDateString("ru-RU");
        parts.push(ds);
      }
    }

    return `Предыдущее: ${parts.join(" · ")}`;
  }

  function buildHistoryPopup(fieldTitle, entries) {
    const popup = document.createElement("div");
    popup.className = "vs-helper-history-popup";

    const titleEl = document.createElement("div");
    titleEl.className = "vs-helper-history-title";
    titleEl.textContent = `История: ${fieldTitle}`;
    popup.appendChild(titleEl);

    const list = document.createElement("ul");
    list.className = "vs-helper-history-list";

    entries.forEach((e) => {
      const li = document.createElement("li");
      li.className = "vs-helper-history-item";

      const parts = [];
      parts.push(String(e.value));

      if (e.visitTitle) parts.push(e.visitTitle);
      if (e.timePoint) parts.push(`ТП: ${e.timePoint}`);

      if (e.visitDate) {
        const d = new Date(e.visitDate);
        if (!isNaN(d.getTime())) {
          const ds = d.toLocaleDateString("ru-RU");
          parts.push(ds);
        }
      }

      li.textContent = parts.join(" · ");
      list.appendChild(li);
    });

    popup.appendChild(list);
    return popup;
  }

  // ---------------------------------------------------------------
  // DOM-наблюдатель + отслеживание SPA-навигации
  // ---------------------------------------------------------------

  function installDomObserver() {
    const rootEl = document.getElementById("root") || document.body;
    if (!rootEl || !window.MutationObserver) {
      log("DOM observer not installed (no root or no MutationObserver)");
      return;
    }

    const observer = new MutationObserver((mutations) => {
      let relevant = false;
      for (const m of mutations) {
        if (m.addedNodes && m.addedNodes.length) {
          relevant = true;
          break;
        }
      }
      if (relevant) {
        triggerScanSoon();
      }
    });

    observer.observe(rootEl, { childList: true, subtree: true });
    log("DOM observer installed");
  }

  function installUrlWatcher() {
    let lastHrefLocal = location.href;

    function check() {
      if (location.href !== lastHrefLocal) {
        const oldHref = lastHrefLocal;
        lastHrefLocal = location.href;
        lastLocationHref = location.href;
        log("URL changed:", oldHref, "->", lastHrefLocal);
        onLocationChange();
      }
    }

    const origPushState = history.pushState;
    const origReplaceState = history.replaceState;

    history.pushState = function () {
      const ret = origPushState.apply(this, arguments);
      check();
      return ret;
    };

    history.replaceState = function () {
      const ret = origReplaceState.apply(this, arguments);
      check();
      return ret;
    };

    window.addEventListener("popstate", check);

    // На всякий случай — периодический опрос
    setInterval(check, 1000);

    log("URL watcher installed");
  }

  function onLocationChange() {
    triggerScanSoon();

    const subjectVisitId = getCurrentSubjectVisitIdFromLocation();
    if (!subjectVisitId) {
      log("onLocationChange: no subjectVisitId in URL");
      return;
    }

    const subjectId = subjectIdByVisitId.get(subjectVisitId);
    if (!subjectId) {
      log(
        "onLocationChange: no subjectId mapping for visit (yet)",
        subjectVisitId
      );
      // Маппинг появится после /api/SubjectsVisit/{id}, который мы тоже перехватываем.
      return;
    }

    ensurePreviousVsLoadedForSubject(subjectId).then(() => {
      triggerScanSoon();
    });
  }

  // ---------------------------------------------------------------
  // Инициализация
  // ---------------------------------------------------------------

  function init() {
    try {
      installXhrHook();
      installDomObserver();
      installUrlWatcher();
      triggerScanSoon();
      log("VS Helper initialized");
    } catch (e) {
      console.error(logPrefix, "Initialization error:", e);
    }
  }

  // Запуск
  init();
})();
