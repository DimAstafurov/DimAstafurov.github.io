// main.js
// Этот файл грузится с хостинга и выполняется в контексте страницы MIS.
// Основная задача: найти форму "Жизненно-важные показатели", подтянуть последние
// значения ЖВП из предыдущего завершённого визита и подсветить их под input'ами.

(function () {
  const LOG_PREFIX = "[VS Helper]";
  function log(...args) {
    console.log(LOG_PREFIX, ...args);
  }

  // ==============================
  // Глобальное состояние
  // ==============================
  const state = {
    // Токен авторизации вида "Bearer xxx"
    authHeader: null,

    // subjectId -> { id, subjectVisitList: [...] } как возвращает /api/Subjects/{id}
    subjectsById: {},

    // subjectId -> [{ id: subjectVisitId, visit: { index, title, ... }, date, ...}, ...]
    subjectVisitsBySubjectId: {},

    // subjectVisitId -> полный объект /api/SubjectsVisit/{id}
    subjectVisitDetailsById: {},

    // subjectId -> { visitId, visitDate, vsForms: [...] }
    lastVsHistoryBySubjectId: {},

    // последний url, чтобы отслеживать SPA-навигацию
    lastUrl: location.href,
  };

  // ==============================
  // Перехват XHR (чтобы достать Authorization и ответ /api/Subjects/*)
  // ==============================

  // ВНИМАНИЕ: этот код должен выполняться именно в контексте страницы, а не isolated world.
  // Обычно расширение в content-script инжектит этот файл через <script src="...">.

  (function patchXHR() {
    const origOpen = XMLHttpRequest.prototype.open;
    const origSend = XMLHttpRequest.prototype.send;
    const origSetRequestHeader = XMLHttpRequest.prototype.setRequestHeader;

    XMLHttpRequest.prototype.open = function (method, url) {
      this._vsMeta = this._vsMeta || {};
      this._vsMeta.method = method;
      this._vsMeta.url = url;
      return origOpen.apply(this, arguments);
    };

    XMLHttpRequest.prototype.setRequestHeader = function (name, value) {
      // Поймаем Authorization, который кладёт само приложение MIS.
      try {
        if (name.toLowerCase() === "authorization" && value && value.startsWith("Bearer ")) {
          if (state.authHeader !== value) {
            state.authHeader = value;
            log("Captured Authorization header");
          }
        }
      } catch (e) {
        // ignore
      }
      return origSetRequestHeader.apply(this, arguments);
    };

    XMLHttpRequest.prototype.send = function () {
      const xhr = this;
      const url = (xhr._vsMeta && xhr._vsMeta.url) || "";

      xhr.addEventListener("readystatechange", function () {
        if (xhr.readyState !== 4) return;

        try {
          // Интересуют только успешные ответы JSON
          if (xhr.status >= 200 && xhr.status < 300) {
            // /api/Subjects/{id} -> список визитов субъекта
            const subjMatch = url.match(/\/api\/Subjects\/([0-9a-fA-F-]+)\b/);
            if (subjMatch) {
              const subjectId = subjMatch[1];
              try {
                const respText = xhr.responseText;
                if (!respText) return;
                const json = JSON.parse(respText);
                handleSubjectResponse(subjectId, json);
              } catch (e) {
                log("Failed to parse /api/Subjects response", e);
              }
              return;
            }

            // /api/SubjectsVisit/{id} -> детали конкретного визита
            const visitMatch = url.match(/\/api\/SubjectsVisit\/([0-9a-fA-F-]+)\b/);
            if (visitMatch) {
              const subjectVisitId = visitMatch[1];
              try {
                const respText = xhr.responseText;
                if (!respText) return;
                const json = JSON.parse(respText);
                handleSubjectVisitResponse(subjectVisitId, json);
              } catch (e) {
                log("Failed to parse /api/SubjectsVisit response", e);
              }
              return;
            }
          }
        } catch (e) {
          log("XHR onreadystatechange error", e);
        }
      });

      return origSend.apply(this, arguments);
    };

    log("XHR patched");
  })();

  // ==============================
  // Обработка /api/Subjects/{id}
  // ==============================

  function handleSubjectResponse(subjectId, json) {
    if (!json || !json.data) return;
    const subject = json.data;
    state.subjectsById[subjectId] = subject;
    const visits = subject.subjectVisitList || [];
    state.subjectVisitsBySubjectId[subjectId] = visits;
    log(
      "Stored visits for subject",
      subjectId,
      "count:",
      visits.length
    );

    // Как только получили список визитов — можно попытаться подтянуть историю VS
    // для текущей страницы, если мы стоим на форме ЖВП.
    debouncedScan();
  }

  // ==============================
  // Обработка /api/SubjectsVisit/{subjectVisitId}
  // ==============================

  function handleSubjectVisitResponse(subjectVisitId, json) {
    if (!json || !json.data) return;
    const data = json.data;
    state.subjectVisitDetailsById[subjectVisitId] = data;
    const forms = data.subjectFormList || [];
    log("Stored subjectVisit", subjectVisitId, "forms:", forms.length);
  }

  // ==============================
  // Вспомогательные функции для URL/ID
  // ==============================

  // /subjectVisit/{subjectVisitId}/...
  function getCurrentSubjectVisitIdFromLocation() {
    const m = location.pathname.match(/\/subjectVisit\/([0-9a-fA-F-]+)/);
    return m ? m[1] : null;
  }

  // Из ответа /api/SubjectsVisit/{id} мы получаем subject.id
  function getSubjectIdFromSubjectVisit(subjectVisitId) {
    const details = state.subjectVisitDetailsById[subjectVisitId];
    if (!details || !details.subject || !details.subject.id) return null;
    return details.subject.id;
  }

  // ==============================
  // Загруженный визит по ID (если не был перехвачен XHR)
  // ==============================

  async function ensureSubjectVisitLoaded(subjectVisitId) {
    if (!subjectVisitId) return null;
    if (state.subjectVisitDetailsById[subjectVisitId]) {
      return state.subjectVisitDetailsById[subjectVisitId];
    }

    if (!state.authHeader) {
      log("ensureSubjectVisitLoaded: no authHeader yet");
      return null;
    }

    const url = `/api/SubjectsVisit/${subjectVisitId}`;
    log("ensureSubjectVisitLoaded: fetching", url);

    const resp = await fetch(url, {
      method: "GET",
      credentials: "include",
      headers: {
        "accept": "application/json, text/plain, */*",
        "authorization": state.authHeader,
      },
    });

    if (!resp.ok) {
      log("ensureSubjectVisitLoaded: fetch failed", resp.status);
      return null;
    }

    const text = await resp.text();
    if (!text) {
      log("ensureSubjectVisitLoaded: empty response body for", subjectVisitId);
      return null;
    }

    let json;
    try {
      json = JSON.parse(text);
    } catch (e) {
      log("ensureSubjectVisitLoaded: JSON parse error", e);
      return null;
    }

    if (!json || !json.data) {
      log("ensureSubjectVisitLoaded: no data field");
      return null;
    }

    state.subjectVisitDetailsById[subjectVisitId] = json.data;
    const forms = json.data.subjectFormList || [];
    log("Stored subjectVisit", subjectVisitId, "forms:", forms.length);

    return json.data;
  }

  // ==============================
  // Определение VS-формы
  // ==============================

  /**
   * Проверяет, является ли объект subjectForm формой "Жизненно-важные показатели".
   * Работает с реальной структурой MIS:
   * subjectForm.form.formType.formTypeKey === "VS"
   *   ИЛИ
   * title содержит "Жизненно-важные показатели"
   */
  function isVsSubjectForm(sf) {
    if (!sf) return false;

    // Реальная структура: sf.form.formType.formTypeKey
    const form = sf.form || {};
    const formType = form.formType || sf.formType || {};

    const title =
      form.title ||
      formType.title ||
      sf.title ||
      "";

    const keyRaw =
      formType.formTypeKey ||
      formType.key ||
      formType.code ||
      form.formKey ||
      form.key ||
      form.code;

    const key = keyRaw ? String(keyRaw).toUpperCase() : "";

    const byKey = key === "VS";
    const byTitle = /Жизненно-важные показатели/i.test(title);

    return byKey || byTitle;
  }

  // ==============================
  // Загрузка "последней истории ЖВП"
  // ==============================

  /**
   * Загружает и кэширует последнюю историю ЖВП по subjectId,
   * используя только ОДИН последний предыдущий визит, в котором есть форма VS.
   *
   * @param {string} subjectId
   * @param {string} currentVisitId - id текущего визита (чтобы его не считать "предыдущим")
   */
  async function ensureLastVsHistoryLoaded(subjectId, currentVisitId) {
    if (!subjectId) {
      log("ensureLastVsHistoryLoaded: no subjectId");
      return null;
    }

    // Если уже кэшировали — просто вернём
    if (state.lastVsHistoryBySubjectId[subjectId]) {
      return state.lastVsHistoryBySubjectId[subjectId];
    }

    const visits = state.subjectVisitsBySubjectId[subjectId] || [];
    if (!visits.length) {
      log("ensureLastVsHistoryLoaded: subject has no visits", subjectId);
      return null;
    }

    // Отсортируем визиты по дате/индексу, чтобы идти от последнего к первому.
    // В ответе /api/Subjects/{id} обычно есть:
    //  - date
    //  - visit.index
    const sorted = [...visits].sort((a, b) => {
      const da = new Date(a.date || 0).getTime();
      const db = new Date(b.date || 0).getTime();
      if (da !== db) return da - db;
      const ia = (a.visit && a.visit.index) || 0;
      const ib = (b.visit && b.visit.index) || 0;
      return ia - ib;
    });

    // Пойдём с конца (последние визиты -> к более ранним)
    let lastVsVisit = null;
    for (let i = sorted.length - 1; i >= 0; i--) {
      const v = sorted[i];
      const svId = v.id;

      // Текущий визит (на котором сейчас стоят) пропускаем, нам нужен предыдущий
      if (svId === currentVisitId) continue;

      // Подгружаем детали визита (если ещё не перехватили XHR)
      const details = await ensureSubjectVisitLoaded(svId);
      if (!details) continue;

      const forms = details.subjectFormList || [];
      const vsForms = forms.filter(isVsSubjectForm);

      log(
        "ensureLastVsHistoryLoaded: visit",
        svId,
        "title:",
        v.visit && v.visit.title,
        "VS forms count:",
        vsForms.length
      );

      if (vsForms.length > 0) {
        lastVsVisit = { visit: v, visitDetails: details, vsForms };
        break; // НАЙДЕН последний предыдущий визит с ЖВП — дальше не идём
      }
    }

    if (!lastVsVisit) {
      log(
        "No previous visit with VS found for subject",
        subjectId,
        "current visit",
        currentVisitId
      );
      state.lastVsHistoryBySubjectId[subjectId] = null;
      return null;
    }

    const result = {
      visitId: lastVsVisit.visit.id,
      visitDate: lastVsVisit.visit.date,
      visitTitle: lastVsVisit.visit.visit && lastVsVisit.visit.visit.title,
      vsForms: lastVsVisit.vsForms,
    };

    state.lastVsHistoryBySubjectId[subjectId] = result;

    log(
      "ensureLastVsHistoryLoaded: found last previous VS visit",
      result.visitId,
      "date:",
      result.visitDate,
      "title:",
      result.visitTitle
    );

    return result;
  }

  // ==============================
  // Инъекция подсказок в DOM (VS-форма)
  // ==============================

  /**
   * Здесь — упрощённая версия: мы не привязываемся к конкретной структуре таблицы,
   * а ищем input'ы внутри формы "Жизненно-важные показатели" и под каждым
   * рисуем маленький текст "Предыдущее значение: ...".
   *
   * В реальности у тебя это уже есть — можешь оставить свою реализацию,
   * а из этого файла использовать только часть с history.
   */
  function injectVsHints(history) {
    if (!history || !history.vsForms || !history.vsForms.length) return;

    // TODO: здесь маппинг полей, как в твоей рабочей версии:
    // (this is just a placeholder to keep file self-contained)
    log("injectVsHints: history found, but DOM injection is placeholder");
  }

  // ==============================
  // Основной проход: найти subjectId, загрузить историю ЖВП, внедрить в DOM
  // ==============================

  async function scanAndInjectForAllFields() {
    const subjectVisitId = getCurrentSubjectVisitIdFromLocation();
    if (!subjectVisitId) {
      log("scanAndInjectForAllFields: no subjectVisitId in URL");
      return;
    }

    const currentVisitDetails = await ensureSubjectVisitLoaded(subjectVisitId);
    if (!currentVisitDetails) {
      log("scanAndInjectForAllFields: cannot load current subjectVisit", subjectVisitId);
      return;
    }

    const subjectId =
      (currentVisitDetails.subject && currentVisitDetails.subject.id) ||
      getSubjectIdFromSubjectVisit(subjectVisitId);

    if (!subjectId) {
      log(
        "scanAndInjectForAllFields: no subjectId for current visit",
        subjectVisitId
      );
      return;
    }

    // Если мы ещё не знаем список визитов этого субъекта — его когда-то должен
    // был загрузить экран "Визиты" через /api/Subjects/{subjectId}. Если нет,
    // то без списка визитов мы не сможем найти предыдущий.
    if (!state.subjectVisitsBySubjectId[subjectId]) {
      log(
        "scanAndInjectForAllFields: no visits array for subject yet",
        subjectId,
        "- wait until /api/Subjects/{id} is called"
      );
      return;
    }

    const history = await ensureLastVsHistoryLoaded(subjectId, subjectVisitId);

    if (!history || !history.vsForms || !history.vsForms.length) {
      log(
        "scanAndInjectForAllFields: history is empty for subject",
        subjectId
      );
      return;
    }

    injectVsHints(history);
  }

  // ==============================
  // Отслеживание SPA-навигации (изменение URL без перезагрузки)
  // ==============================

  function observeUrlChanges() {
    // Переопределяем pushState/replaceState
    const origPushState = history.pushState;
    const origReplaceState = history.replaceState;

    function handleUrlChange() {
      const current = location.href;
      if (current === state.lastUrl) return;
      const prev = state.lastUrl;
      state.lastUrl = current;
      log("URL changed", prev, "->", current);
      debouncedScan();
    }

    history.pushState = function () {
      const res = origPushState.apply(this, arguments);
      handleUrlChange();
      return res;
    };

    history.replaceState = function () {
      const res = origReplaceState.apply(this, arguments);
      handleUrlChange();
      return res;
    };

    window.addEventListener("popstate", handleUrlChange);
  }

  // ==============================
  // debounce для повторных сканов
  // ==============================

  let scanTimer = null;
  function debouncedScan() {
    if (scanTimer) clearTimeout(scanTimer);
    scanTimer = setTimeout(() => {
      scanTimer = null;
      scanAndInjectForAllFields().catch((e) =>
        log("scanAndInjectForAllFields error", e)
      );
    }, 500);
  }

  // ==============================
  // Старт
  // ==============================

  function init() {
    log("init");
    observeUrlChanges();
    // Первичный запуск на уже загруженной странице
    debouncedScan();
  }

  // Даём странице чуть-чуть времени, чтобы XHR-патч точно встал до первых запросов
  setTimeout(init, 1000);
})();
