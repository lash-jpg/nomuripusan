/**
 * 무리없이 부산 — 온보딩 3단계 로직 (모바일 + PC 동기화).
 */
(function () {
  let currentStep = 1;

  // 모바일/PC 공통 헬퍼
  function getAll(id) {
    const els = [];
    if (document.getElementById(id)) els.push(document.getElementById(id));
    if (document.getElementById(id + 'Pc')) els.push(document.getElementById(id + 'Pc'));
    return els;
  }

  const steps = [
    document.getElementById('step1'),
    document.getElementById('step2'),
    document.getElementById('step3'),
  ];
  const progressFill = document.getElementById('progressFill');
  const headerTitle = document.getElementById('headerTitle');
  const stepIndicator = document.getElementById('stepIndicator');
  const backBtn = document.getElementById('backBtn');

  let _step3MapsInited = false;
  function showStep(n) {
    currentStep = n;
    steps.forEach((s, i) => {
      if (s) s.style.display = i === n - 1 ? 'block' : 'none';
    });
    if (progressFill) progressFill.style.width = Math.round((n / 3) * 100) + '%';
    if (stepIndicator) stepIndicator.textContent = n + ' / 3';
    const titles = ['여행자 정보 입력', '여행 기간', '권역 선택'];
    if (headerTitle) headerTitle.textContent = titles[n - 1];
    // PC 스텝바 active/completed 상태 갱신
    ['pcStep1', 'pcStep2', 'pcStep3'].forEach(function (id, i) {
      var el = document.getElementById(id);
      if (!el) return;
      el.classList.toggle('active', i === n - 1);
      el.classList.toggle('done', i < n - 1);
    });
    window.scrollTo({ top: 0, behavior: 'smooth' });
    // Step 3 진입 시 Kakao 지도 1회 초기화 (display:none 상태로는 지도 렌더가 불가능해 지연 로드)
    if (n === 3 && !_step3MapsInited) {
      _step3MapsInited = true;
      setTimeout(function () {
        initStep3Map('step3KakaoMap', 'step3MapFallback', 'mobile');
        initStep3Map('step3KakaoMapPc', 'step3MapFallbackPc', 'pc');
      }, 30);
    }
  }

  /* 뒤로 가기 */
  if (backBtn) {
    backBtn.addEventListener('click', function () {
      if (currentStep > 1) showStep(currentStep - 1);
      else navigateTo('/');
    });
  }

  /* ── Step 1: 유형 선택 ── */
  function syncTypeCards() {
    const selectedTypes = AppState.mobility_types;
    getAll('typeGrid').forEach(function (grid) {
      grid.querySelectorAll('.ob-choice-card').forEach(function (card) {
        const sel = selectedTypes.includes(card.dataset.type);
        card.classList.toggle('selected', sel);
        card.setAttribute('aria-checked', sel ? 'true' : 'false');
      });
    });
    const disabled = selectedTypes.length === 0;
    getAll('step1Next').forEach(function (btn) { btn.disabled = disabled; });
  }

  getAll('typeGrid').forEach(function (grid) {
    grid.addEventListener('click', function (e) {
      const card = e.target.closest('.ob-choice-card');
      if (!card) return;
      const types = AppState.mobility_types.slice();
      const t = card.dataset.type;
      const idx = types.indexOf(t);
      if (idx === -1) types.push(t); else types.splice(idx, 1);
      AppState.mobility_types = types;
      syncTypeCards();
    });
    grid.addEventListener('keydown', function (e) {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        const card = e.target.closest('.ob-choice-card');
        if (card) card.click();
      }
    });
  });

  getAll('step1Next').forEach(function (btn) {
    btn.addEventListener('click', function () {
      if (AppState.mobility_types.length > 0) {
        typeof logInteraction === 'function' && logInteraction('onboarding_step', { step: 1, mobility_types: AppState.mobility_types });
        showStep(2);
      }
    });
  });

  /* ── Step 2: 시작일 + 기간 선택 ── */
  // 날짜 동기화 (모바일/PC)
  ['startDate', 'startDatePc'].forEach(function (id) {
    const el = document.getElementById(id);
    if (!el) return;
    // 기본값: 오늘
    if (!AppState.start_date) {
      AppState.start_date = new Date().toISOString().slice(0, 10);
    }
    el.value = AppState.start_date;
    el.min = new Date().toISOString().slice(0, 10);
    el.addEventListener('change', function () {
      AppState.start_date = el.value;
      // 다른 필드도 동기화
      ['startDate', 'startDatePc'].forEach(function (otherId) {
        const other = document.getElementById(otherId);
        if (other && other !== el) other.value = el.value;
      });
    });
  });

  function syncDurationChips() {
    const days = AppState.days;
    getAll('durationRow').forEach(function (row) {
      row.querySelectorAll('.duration-chip').forEach(function (chip) {
        const sel = parseInt(chip.dataset.days, 10) === days;
        chip.classList.toggle('selected', sel);
        chip.setAttribute('aria-checked', sel ? 'true' : 'false');
      });
    });
    const disabled = days === 0;
    getAll('step2Next').forEach(function (btn) { btn.disabled = disabled; });
  }

  getAll('durationRow').forEach(function (row) {
    row.addEventListener('click', function (e) {
      const chip = e.target.closest('.duration-chip');
      if (!chip) return;
      AppState.days = parseInt(chip.dataset.days, 10);
      syncDurationChips();
    });
    row.addEventListener('keydown', function (e) {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        const chip = e.target.closest('.duration-chip');
        if (chip) chip.click();
      }
    });
  });

  getAll('step2Next').forEach(function (btn) {
    btn.addEventListener('click', function () {
      if (AppState.days > 0) {
        typeof logInteraction === 'function' && logInteraction('onboarding_step', { step: 2, days: AppState.days, start_date: AppState.start_date });
        showStep(3);
      }
    });
  });

  /* ── Step 3: 권역 선택 ── */
  // 부산 9개 권역 좌표 (지도 마커용)
  const AREA_COORDS = {
    '해운대': { lat: 35.1631, lng: 129.1637 },
    '남포':   { lat: 35.0977, lng: 129.0307 },
    '영도':   { lat: 35.0910, lng: 129.0680 },
    '기장':   { lat: 35.2446, lng: 129.2226 },
    '수영':   { lat: 35.1455, lng: 129.1131 },
    '서구':   { lat: 35.0976, lng: 129.0244 },
    '사하':   { lat: 35.1045, lng: 128.9747 },
    '남구':   { lat: 35.1334, lng: 129.0845 },
    '북항':   { lat: 35.1115, lng: 129.0421 },
  };
  const BUSAN_CENTER = { lat: 35.1796, lng: 129.0756 };

  /* Kakao Maps SDK 로더 (여러 페이지에서 재사용) */
  let _kakaoLoader = null;
  function loadKakaoSdk() {
    if (window.kakao && window.kakao.maps && window.kakao.maps.LatLng) {
      return Promise.resolve(window.kakao);
    }
    if (_kakaoLoader) return _kakaoLoader;
    if (!window.KAKAO_MAP_KEY) {
      return Promise.reject(new Error('KAKAO_MAP_KEY missing'));
    }
    _kakaoLoader = new Promise(function (resolve, reject) {
      const existing = document.getElementById('kakao-map-sdk');
      const finish = function () {
        if (!window.kakao) { _kakaoLoader = null; return reject(new Error('kakao not ready')); }
        window.kakao.maps.load(function () { resolve(window.kakao); });
      };
      if (existing) {
        if (window.kakao) { finish(); return; }
        existing.addEventListener('load', finish, { once: true });
        existing.addEventListener('error', function (e) { _kakaoLoader = null; reject(e); }, { once: true });
        setTimeout(function () { if (window.kakao) finish(); }, 200);
        return;
      }
      const s = document.createElement('script');
      s.id = 'kakao-map-sdk';
      s.src = 'https://dapi.kakao.com/v2/maps/sdk.js?appkey=' + window.KAKAO_MAP_KEY +
              '&autoload=false&libraries=services';
      s.onload = finish;
      s.onerror = function (e) { _kakaoLoader = null; reject(e); };
      document.head.appendChild(s);
    });
    return _kakaoLoader;
  }

  // 권역별 오버레이 ref를 저장해 칩/마커 상호 동기화에 활용
  const _overlayRefs = { mobile: {}, pc: {} };

  function buildAreaOverlay(area, selected) {
    const wrap = document.createElement('div');
    wrap.className = 'step3-area-marker' + (selected ? ' selected' : '');
    wrap.textContent = area;
    wrap.setAttribute('role', 'button');
    wrap.setAttribute('tabindex', '0');
    wrap.setAttribute('aria-label', area + ' 선택');
    wrap.addEventListener('click', function (ev) {
      ev.stopPropagation();
      toggleArea(area);
    });
    wrap.addEventListener('keydown', function (ev) {
      if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); toggleArea(area); }
    });
    return wrap;
  }

  function toggleArea(area) {
    const areas = AppState.areas.slice();
    const idx = areas.indexOf(area);
    if (idx === -1) areas.push(area); else areas.splice(idx, 1);
    AppState.areas = areas;
    syncAreaChips();
    syncMapMarkers();
  }

  function syncMapMarkers() {
    const sel = new Set(AppState.areas);
    ['mobile', 'pc'].forEach(function (key) {
      Object.keys(_overlayRefs[key]).forEach(function (area) {
        const el = _overlayRefs[key][area];
        if (!el) return;
        el.classList.toggle('selected', sel.has(area));
      });
    });
  }

  async function initStep3Map(containerId, fallbackId, refKey) {
    const container = document.getElementById(containerId);
    const fallback = document.getElementById(fallbackId);
    if (!container) return;
    if (!window.KAKAO_MAP_KEY) {
      renderMapFallback(fallback, container);
      return;
    }
    try {
      await loadKakaoSdk();
      const kakao = window.kakao;
      const center = new kakao.maps.LatLng(BUSAN_CENTER.lat, BUSAN_CENTER.lng);
      const map = new kakao.maps.Map(container, { center, level: 8, draggable: true });
      Object.keys(AREA_COORDS).forEach(function (area) {
        const c = AREA_COORDS[area];
        const pos = new kakao.maps.LatLng(c.lat, c.lng);
        const content = buildAreaOverlay(area, AppState.areas.indexOf(area) !== -1);
        _overlayRefs[refKey][area] = content;
        new kakao.maps.CustomOverlay({ position: pos, content: content, map: map, yAnchor: 0.5, xAnchor: 0.5, zIndex: 10 });
      });
      // 지도에 모든 권역이 보이도록 bounds 조정
      const bounds = new kakao.maps.LatLngBounds();
      Object.values(AREA_COORDS).forEach(function (c) {
        bounds.extend(new kakao.maps.LatLng(c.lat, c.lng));
      });
      map.setBounds(bounds, 30, 30, 30, 30);

      // 도메인 등록이 안 돼 있어 타일이 로드되지 않으면 2초 후 폴백으로 전환
      let _tilesLoaded = false;
      kakao.maps.event.addListener(map, 'tilesloaded', function () { _tilesLoaded = true; });
      setTimeout(function () {
        if (!_tilesLoaded) {
          console.warn('Kakao 지도 타일 로드 실패 (도메인 등록 확인 필요) — 폴백 UI 전환');
          renderMapFallback(fallback, container);
        }
      }, 2500);
    } catch (err) {
      console.warn('Kakao SDK 로드 실패, 폴백 UI 사용:', err && err.message);
      renderMapFallback(fallback, container);
    }
  }

  function renderMapFallback(fallback, container) {
    if (!fallback) return;
    if (container) container.style.display = 'none';
    fallback.hidden = false;
    // 지도 없이 아래 area-chip-grid가 단독 담당 — 이중 표시 방지
    fallback.innerHTML =
      '<div class="step3-fallback-header">' +
        '<span class="step3-fallback-icon">📍</span>' +
        '<div class="step3-fallback-texts">' +
          '<span class="step3-fallback-label">권역을 선택해주세요</span>' +
          '<span class="step3-fallback-hint">미선택 시 전체 지역을 추천해요</span>' +
        '</div>' +
      '</div>';
  }

  function syncAreaChips() {
    const areas = AppState.areas;
    getAll('areaGrid').forEach(function (grid) {
      grid.querySelectorAll('.area-chip').forEach(function (chip) {
        const sel = areas.includes(chip.dataset.area);
        chip.classList.toggle('selected', sel);
        chip.setAttribute('aria-checked', sel ? 'true' : 'false');
      });
    });
    syncMapMarkers();
  }

  getAll('areaGrid').forEach(function (grid) {
    grid.addEventListener('click', function (e) {
      const chip = e.target.closest('.area-chip');
      if (!chip) return;
      const areas = AppState.areas.slice();
      const a = chip.dataset.area;
      const idx = areas.indexOf(a);
      if (idx === -1) areas.push(a); else areas.splice(idx, 1);
      AppState.areas = areas;
      syncAreaChips();
    });
    grid.addEventListener('keydown', function (e) {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        const chip = e.target.closest('.area-chip');
        if (chip) chip.click();
      }
    });
  });

  getAll('step3Next').forEach(function (btn) {
    btn.addEventListener('click', async function () {
      if (!AppState.days) return showToast('일정을 선택해주세요');

      getAll('step3Next').forEach(function (b) {
        b.disabled = true;
        b.classList.add('loading');
        b.innerHTML = '<span class="btn-spinner"></span>추천 코스 분석 중...';
      });

      typeof logInteraction === 'function' && logInteraction('onboarding_complete', {
        mobility_types: AppState.mobility_types,
        days: AppState.days,
        areas: AppState.areas,
        start_date: AppState.start_date,
      });

      const result = await requestRecommendations();

      if (!result?.courses?.length) {
        getAll('step3Next').forEach(function (b) {
          b.disabled = false;
          b.classList.remove('loading');
          b.textContent = '코스 추천받기 →';
        });
        showToast('추천 결과를 가져올 수 없습니다. 다시 시도해주세요.', 'error');
      } else {
        navigateTo('/results.html');
      }
    });
  });

  /* ── 초기 상태 복원 ── */
  syncTypeCards();
  syncDurationChips();
  syncAreaChips();
  showStep(1);
})();
