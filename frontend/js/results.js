/**
 * 무리없이 부산 — 추천 결과 렌더링.
 */

async function loadWeather() {
  const banner = document.getElementById('weatherBanner');
  if (!banner) return;
  let weather;
  try {
    const data = await apiGet('/api/weather');
    if (data && data.available) {
      weather = data;
      banner.innerHTML = `<span>${escapeHtml(data.icon)} 부산 현재 날씨 ${escapeHtml(data.sky)} ${escapeHtml(data.tmp)}</span>`;
      banner.style.display = 'flex';
    }
  } catch(e) { weather = { icon: '🌤', desc: '날씨 정보 없음' }; showToast('날씨 정보를 불러올 수 없습니다'); }
}
loadWeather();

(function () {
  const resultList = document.getElementById('resultList');
  const resultSummary = document.getElementById('resultSummary');
  const filterTabs = document.getElementById('filterTabs');
  const dayTabs = document.getElementById('dayTabs');
  const dayTabBar = document.getElementById('dayTabBar');
  const loadingState = document.getElementById('loadingState');
  const resultMapWrap = document.getElementById('resultMapWrap');
  const resultMapEl = document.getElementById('resultMap');
  const resultMapLegend = document.getElementById('resultMapLegend');

  // Day 별 마커 색상 (activeDay=0 전체 보기에서 day 구분)
  const DAY_COLORS = {
    1: '#003087', 2: '#B45309', 3: '#059669', 4: '#7C3AED', 5: '#DB2777',
  };

  // ── Kakao SDK 로더 (results 페이지 지도용) ────────────────────
  let _kakaoLoader = null;
  function loadKakaoSdk() {
    if (window.kakao && window.kakao.maps && window.kakao.maps.LatLng) {
      return Promise.resolve(window.kakao);
    }
    if (_kakaoLoader) return _kakaoLoader;
    if (!window.KAKAO_MAP_KEY) return Promise.reject(new Error('KAKAO_MAP_KEY missing'));
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

  function collectSpotsForMap(courses) {
    const out = [];
    courses.forEach(function (c) {
      (c.spots || []).forEach(function (s) {
        if (typeof s.lat === 'number' && typeof s.lng === 'number') {
          out.push({
            lat: s.lat, lng: s.lng, name: s.name,
            day: c.day || 1, courseId: c.id, courseName: c.name,
          });
        }
      });
    });
    return out;
  }

  // Map/overlay 인스턴스를 재활용해 메모리 누수와 중복 렌더를 방지한다.
  let _resultMap = null;
  let _resultMapOverlays = [];
  let _resultMapMarkers = [];
  let _resultRenderSeq = 0;
  const _renderedMarkerListeners = [];

  function clearResultMapOverlays() {
    _resultMapOverlays.forEach(function (o) { try { o.setMap(null); } catch (_) {} });
    _resultMapOverlays = [];
    if (window.kakao && window.kakao.maps && window.kakao.maps.event) {
      _renderedMarkerListeners.forEach(function (entry) {
        try { window.kakao.maps.event.removeListener(entry.marker, 'click', entry.handler); } catch (_) {}
      });
    }
    _renderedMarkerListeners.length = 0;
    _resultMapMarkers.forEach(function (m) { try { m.setMap(null); } catch (_) {} });
    _resultMapMarkers = [];
  }

  async function renderResultKakaoMap(spots) {
    const kakao = await loadKakaoSdk();
    const mySeq = ++_resultRenderSeq;
    // 첫 렌더 때만 Map 인스턴스 생성 — 이후는 오버레이만 교체
    if (!_resultMap) {
      resultMapEl.innerHTML = '';
      const center = new kakao.maps.LatLng(spots[0].lat, spots[0].lng);
      _resultMap = new kakao.maps.Map(resultMapEl, { center: center, level: 8 });
    } else {
      clearResultMapOverlays();
    }
    const map = _resultMap;
    const bounds = new kakao.maps.LatLngBounds();
    spots.forEach(function (s) {
      const pos = new kakao.maps.LatLng(s.lat, s.lng);
      const color = DAY_COLORS[s.day] || DAY_COLORS[1];
      const content =
        '<div style="background:' + color + ';color:#fff;min-width:22px;height:22px;padding:0 6px;' +
        'border-radius:11px;display:flex;align-items:center;justify-content:center;' +
        'font-size:11px;font-weight:700;border:2px solid #fff;box-shadow:0 2px 6px rgba(0,0,0,.3);' +
        'white-space:nowrap">Day ' + s.day + '</div>';
      const overlay = new kakao.maps.CustomOverlay({ position: pos, content: content, map: map, yAnchor: 0.5, xAnchor: 0.5, zIndex: 5 });
      _resultMapOverlays.push(overlay);
      const info = new kakao.maps.InfoWindow({
        content: '<div style="padding:6px 10px;font-size:12px;max-width:180px;white-space:nowrap">' +
                 escapeHtml(s.name) + ' · Day ' + s.day + '</div>',
      });
      const marker = new kakao.maps.Marker({ position: pos, map: map, opacity: 0 });
      const handler = function () { info.open(map, marker); };
      kakao.maps.event.addListener(marker, 'click', handler);
      _renderedMarkerListeners.push({ marker: marker, handler: handler });
      _resultMapMarkers.push(marker);
      bounds.extend(pos);
    });
    // 렌더 레이스 방지: 가장 최신 렌더 호출의 bounds만 적용
    if (mySeq === _resultRenderSeq) {
      map.setBounds(bounds, 40, 40, 40, 40);
    }

    // 타일 로드 실패(도메인 미등록 등) 시 SVG mock 으로 폴백 (첫 렌더만 감지)
    if (!map.__tilesCheckAttached) {
      map.__tilesCheckAttached = true;
      let _tilesLoaded = false;
      kakao.maps.event.addListener(map, 'tilesloaded', function () { _tilesLoaded = true; });
      setTimeout(function () {
        if (!_tilesLoaded) {
          console.warn('Result map: Kakao 타일 로드 실패 — SVG mock 으로 폴백');
          _resultMap = null;  // 폴백 시 다음에 재생성되도록 리셋
          renderResultMockMap(spots);
        }
      }, 2500);
    }
  }

  function renderResultMockMap(spots) {
    if (!spots.length) { resultMapEl.innerHTML = ''; return; }
    const W = 720, H = 260;
    const lats = spots.map(s => s.lat), lngs = spots.map(s => s.lng);
    const minLat = Math.min(...lats), maxLat = Math.max(...lats);
    const minLng = Math.min(...lngs), maxLng = Math.max(...lngs);
    const pad = 40;
    const toX = lng => maxLng === minLng ? W / 2 : pad + (lng - minLng) / (maxLng - minLng) * (W - pad * 2);
    const toY = lat => maxLat === minLat ? H / 2 : pad + (maxLat - lat) / (maxLat - minLat) * (H - pad * 2);
    resultMapEl.innerHTML =
      '<svg viewBox="0 0 ' + W + ' ' + H + '" xmlns="http://www.w3.org/2000/svg" style="width:100%;height:100%;">' +
        '<rect width="' + W + '" height="' + H + '" fill="#e8f0fe" rx="8"/>' +
        spots.map(function (s) {
          const color = DAY_COLORS[s.day] || DAY_COLORS[1];
          const x = toX(s.lng), y = toY(s.lat);
          return '<circle cx="' + x + '" cy="' + y + '" r="8" fill="' + color + '" stroke="#fff" stroke-width="2"/>' +
                 '<text x="' + x + '" y="' + (y + 20) + '" text-anchor="middle" font-size="9" fill="#172B4D" font-family="sans-serif">' +
                   escapeHtml(s.name.length > 5 ? s.name.slice(0, 5) + '…' : s.name) + '</text>';
        }).join('') +
      '</svg>';
  }

  function renderMapLegend(daysUsed) {
    if (!resultMapLegend) return;
    const items = daysUsed.map(function (d) {
      return '<span class="result-map-legend-item">' +
        '<span class="result-map-legend-dot" style="background:' + (DAY_COLORS[d] || DAY_COLORS[1]) + '"></span>' +
        'Day ' + d + '</span>';
    }).join('');
    resultMapLegend.innerHTML = items;
  }

  async function updateResultMap(coursesForMap) {
    if (!resultMapWrap || !resultMapEl) return;
    const spots = collectSpotsForMap(coursesForMap);
    if (!spots.length) {
      resultMapWrap.style.display = 'none';
      return;
    }
    resultMapWrap.style.display = '';
    const daysUsed = Array.from(new Set(spots.map(s => s.day))).sort((a, b) => a - b);
    renderMapLegend(daysUsed);
    if (!window.KAKAO_MAP_KEY) {
      renderResultMockMap(spots);
      return;
    }
    try {
      await renderResultKakaoMap(spots);
    } catch (err) {
      renderResultMockMap(spots);
    }
  }

  const typeLabels = {
    wheelchair: '휠체어',
    stroller: '유아차',
    senior: '시니어',
    carrier: '보행보조',
  };

  const dayLabelsMap = { 1: '첫째 날', 2: '둘째 날', 3: '셋째 날', 4: '넷째 날', 5: '다섯째 날' };

  let allCourses = [];
  let activeFilter = 'all';
  let activeDay = 0;  // 0 = 전체 보기, 1+ = 특정 day만

  function getCategoryFallback(course) {
    const name = (course.name || '') + (course.spots?.map(s => s.name).join('') || '');
    if (/해수욕|바다|해변|해안|송도|광안|해운대/.test(name)) return { icon: '🏖️', bg: '#DBEAFE', color: '#1e40af' };
    if (/공원|산|자연|숲|생태/.test(name))                    return { icon: '🌿', bg: '#D1FAE5', color: '#065f46' };
    if (/박물관|전시|역사|문화|기념/.test(name))               return { icon: '🏛️', bg: '#E0E7FF', color: '#3730a3' };
    if (/음식|맛집|시장|먹거리|식당/.test(name))               return { icon: '🍜', bg: '#FEF3C7', color: '#92400e' };
    if (/교통|역|터미널|항구/.test(name))                      return { icon: '🚌', bg: '#F3F4F6', color: '#374151' };
    return { icon: '📍', bg: 'linear-gradient(135deg,#003087,#0052cc)', color: 'rgba(255,255,255,0.8)' };
  }

  function showSkeletons() {
    if (loadingState) {
      loadingState.style.display = 'none';
    }
    resultList.innerHTML = '';
    for (let i = 0; i < 3; i++) {
      const sk = document.createElement('div');
      sk.className = 'skeleton-card';
      sk.innerHTML = `
        <div class="sk sk-img"></div>
        <div class="sk sk-title"></div>
        <div class="sk sk-text"></div>
        <div class="sk sk-text sk-short"></div>`;
      resultList.appendChild(sk);
    }
  }

  function hideSkeletons() {
    resultList.querySelectorAll('.skeleton-card').forEach(el => el.remove());
  }

  function getFilterLabel() {
    if (activeFilter === 'favorites') {
      return '즐겨찾기';
    }
    if (activeFilter === 'low-fatigue') {
      return '저피로순';
    }
    if (activeFilter === 'many-spots') {
      return '관광지 많은순';
    }
    return '전체';
  }

  function updateFilterTabs() {
    if (!filterTabs) return;
    filterTabs.querySelectorAll('.filter-tab').forEach(function (tab) {
      tab.classList.toggle('active', tab.dataset.filter === activeFilter);
    });
  }

  function getFilteredCourses() {
    let filtered = [...allCourses];
    // Day 필터 (멀티데이일 때만 적용)
    const totalDays = parseInt(AppState.days, 10) || 1;
    if (totalDays > 1 && activeDay > 0) {
      filtered = filtered.filter(course => (course.day || 1) === activeDay);
    }
    if (activeFilter === 'favorites') {
      filtered = filtered.filter(course => AppFavorites.has(course.id));
    } else if (activeFilter === 'low-fatigue') {
      filtered.sort((a, b) => a.total_fatigue - b.total_fatigue);
    } else if (activeFilter === 'many-spots') {
      filtered.sort((a, b) => b.spots.length - a.spots.length);
    }
    return filtered;
  }

  function renderDayTabs() {
    if (!dayTabs || !dayTabBar) return;
    const totalDays = parseInt(AppState.days, 10) || 1;
    if (totalDays <= 1) {
      dayTabBar.style.display = 'none';
      return;
    }
    // 코스가 있는 day만 탭으로 노출
    const dayCounts = new Map();
    allCourses.forEach(c => {
      const d = c.day || 1;
      dayCounts.set(d, (dayCounts.get(d) || 0) + 1);
    });
    // 1일 이하로 코스가 생성되었으면 탭 숨김 (외로운 Day 탭 방지)
    if (dayCounts.size <= 1) {
      dayTabBar.style.display = 'none';
      return;
    }
    const sortedDays = Array.from(dayCounts.keys()).sort((a, b) => a - b);
    // activeDay가 코스 없는 day면 전체 보기(0)로 보정 (0은 항상 유효)
    if (activeDay !== 0 && !dayCounts.has(activeDay)) activeDay = 0;

    dayTabBar.style.display = '';
    const totalCount = allCourses.length;
    const allTab = `<button class="day-tab${activeDay === 0 ? ' active' : ''}" data-day="0" aria-pressed="${activeDay === 0}">
      <span class="day-tab-num">전체</span>
      <span class="day-tab-label">전체 요약</span>
      <span class="day-tab-count">${totalCount}코스</span>
    </button>`;
    dayTabs.innerHTML = allTab + sortedDays.map(d => {
      const isActive = d === activeDay;
      const label = dayLabelsMap[d] || `${d}일차`;
      const count = dayCounts.get(d);
      return `<button class="day-tab${isActive ? ' active' : ''}" data-day="${d}" aria-pressed="${isActive}">
        <span class="day-tab-num">Day ${d}</span>
        <span class="day-tab-label">${label}</span>
        <span class="day-tab-count">${count}코스</span>
      </button>`;
    }).join('');

    dayTabs.querySelectorAll('.day-tab').forEach(btn => {
      btn.addEventListener('click', function () {
        const requested = parseInt(this.dataset.day, 10);
        const availableDays = Array.from(dayCounts.keys()).sort((a, b) => a - b);
        const prevDay = activeDay;
        if (requested === 0) {
          // 전체 탭은 항상 전체 보기로
          activeDay = 0;
        } else if (requested === activeDay) {
          // 같은 day를 다시 클릭하면 전체 보기로 전환
          activeDay = 0;
        } else {
          activeDay = requested;
        }
        if (prevDay !== activeDay) {
          logInteraction('day_tab_change', { day_number: activeDay, previous_day: prevDay });
        }
        renderDayTabs();
        renderCurrentFilter();
        // 결과 영역 상단으로 부드럽게 스크롤
        if (resultList) resultList.scrollIntoView({ behavior: 'smooth', block: 'start' });
      });
    });
  }

  function formatTripPeriod(startDate, days) {
    if (!startDate) return '';
    const start = new Date(startDate);
    if (isNaN(start.getTime())) return startDate;
    const dayCount = Math.max(1, parseInt(days, 10) || 1);
    if (dayCount === 1) {
      return startDate;
    }
    const end = new Date(start);
    end.setDate(start.getDate() + dayCount - 1);
    const pad = (n) => String(n).padStart(2, '0');
    const endStr = `${end.getFullYear()}-${pad(end.getMonth() + 1)}-${pad(end.getDate())}`;
    return `${startDate} ~ ${endStr}`;
  }

  function weatherChip(weather) {
    if (!weather) return '';
    // available=false여도 sky/tmp가 있으면 표시
    const icon = weather.icon || '⛅';
    const sky = weather.sky || '';
    const tmp = weather.tmp || '';
    const parts = [icon];
    if (sky) parts.push(sky);
    if (tmp) parts.push(tmp);
    if (parts.length === 1) return ''; // 아이콘만 있으면 표시 X
    return `<span class="summary-chip summary-chip-weather">날씨 ${parts.join(' ')}</span>`;
  }

  function renderSummary(courses) {
    const meta = AppState.recommendation_meta || {};
    const selectedTypes = AppState.mobility_types.map(type => typeLabels[type] || type).join(' · ') || '선택 없음';
    const selectedAreas = AppState.areas.length ? AppState.areas.join(' · ') : '부산 전역';
    const appliedAreas = (meta.applied_areas || []).length ? meta.applied_areas.join(' · ') : selectedAreas;
    const fallbackBanner = meta.fallback_used ? `
      <div class="result-advisory" role="status" aria-live="polite">
        <strong>권역 확장 안내</strong>
        <span>${meta.message || '선택 권역에서 결과가 부족해 추천 범위를 넓혔습니다.'}</span>
      </div>` : '';
    const festivalCount = meta.festival_count || 0;
    const festivalBanner = festivalCount > 0 ? `
      <div class="result-advisory" role="status" style="background:#fff8e1;border-color:#ffe082">
        <strong>🎪 행사 ${festivalCount}건 포함</strong>
        <span>여행 기간 중 진행되는 행사·축제가 코스에 자동 반영되었습니다.</span>
      </div>` : '';

    resultSummary.innerHTML = `
      <div class="result-summary-head">
        <div>
          <div class="info"><strong>${courses.length}개</strong> 코스 추천</div>
          <p class="result-summary-copy">${getFilterLabel()} 기준으로 정렬된 결과예요.</p>
        </div>
        <div class="result-summary-actions">
          <button class="btn-outline summary-btn" id="refreshResultsBtn">다시 분석</button>
          <button class="btn-primary summary-btn" id="editConditionsBtn">조건 수정</button>
        </div>
      </div>
      <div class="result-summary-chips" aria-label="추천 조건 요약">
        <span class="summary-chip">여행자 ${selectedTypes}</span>
        <span class="summary-chip">${AppState.days}일 일정</span>
        ${AppState.start_date ? `<span class="summary-chip">기간 ${formatTripPeriod(AppState.start_date, AppState.days)}</span>` : ''}
        ${weatherChip(meta.weather)}
        <span class="summary-chip">요청 권역 ${selectedAreas}</span>
        <span class="summary-chip">적용 권역 ${appliedAreas}</span>
      </div>
      ${fallbackBanner}
      ${festivalBanner}`;

    const refreshBtn = document.getElementById('refreshResultsBtn');
    const editBtn = document.getElementById('editConditionsBtn');
    if (refreshBtn) {
      refreshBtn.addEventListener('click', function () {
        logInteraction('refresh_click', { filter_active: activeFilter, course_count: courses.length });
        rerunRecommendations();
      });
    }
    if (editBtn) {
      editBtn.addEventListener('click', function () {
        logInteraction('edit_conditions', { filter_active: activeFilter });
        navigateTo('/onboarding.html');
      });
    }
  }

  function renderEmptyState() {
    const title = activeFilter === 'favorites'
      ? '즐겨찾기한 코스가 없습니다'
      : '조건에 맞는 코스가 없습니다';
    const message = activeFilter === 'favorites'
      ? '마음에 드는 코스를 찜해두면 여기서 빠르게 다시 볼 수 있어요.'
      : '권역이나 여행자 유형을 조금 넓혀서 다시 추천받아보세요.';
    resultList.innerHTML = `
      <div class="empty-state">
        <div class="icon" aria-hidden="true">${activeFilter === 'favorites' ? '♡' : '📭'}</div>
        <h3>${title}</h3>
        <p>${message}</p>
      </div>`;
  }

  function renderOverviewTab(courses) {
    if (loadingState) loadingState.style.display = 'none';

    const totalSpots = [...new Set(courses.flatMap(c => c.spots.map(s => s.id || s.name)))].length;
    const barrierFreeCount = courses.flatMap(c => c.spots).filter(s => s.wheelchair_accessible === true).length;
    const totalDays = parseInt(AppState.days, 10) || 1;
    const avgFatigue = courses.length ? Math.round(courses.reduce((a, c) => a + c.total_fatigue, 0) / courses.length) : 0;

    const dayHighlights = [];
    for (let d = 1; d <= totalDays; d++) {
      const dayCourses = courses.filter(c => (c.day || 1) === d);
      if (dayCourses.length) {
        const best = dayCourses.slice().sort((a, b) => a.total_fatigue - b.total_fatigue)[0];
        dayHighlights.push({ day: d, course: best });
      }
    }

    resultList.innerHTML = `
      <div class="overview-tab">
        <div class="overview-stats">
          <div class="overview-stat">
            <div class="overview-stat-num">${courses.length}</div>
            <div class="overview-stat-label">추천 코스</div>
          </div>
          <div class="overview-stat">
            <div class="overview-stat-num">${totalSpots}</div>
            <div class="overview-stat-label">총 장소</div>
          </div>
          <div class="overview-stat">
            <div class="overview-stat-num">${barrierFreeCount}</div>
            <div class="overview-stat-label">배리어프리 ♿</div>
          </div>
          <div class="overview-stat">
            <div class="overview-stat-num">${avgFatigue}</div>
            <div class="overview-stat-label">평균 피로도</div>
          </div>
        </div>

        <h3 class="overview-section-title">📅 일자별 추천 하이라이트</h3>
        <div class="overview-highlights">
          ${dayHighlights.map(({ day, course }) => {
            const thumb = course.spots[0]?.image_url;
            const fb = getCategoryFallback(course);
            return `
            <div class="overview-day-card" data-course-id="${course.id}">
              <div class="overview-day-thumb" data-fb-bg="${escapeHtml(fb.bg)}" data-fb-icon="${escapeHtml(fb.icon)}" style="background:${thumb ? 'transparent' : fb.bg}">
                ${thumb
                  ? `<img src="${escapeHtml(thumb)}" alt="${escapeHtml(course.spots[0].name)}" loading="lazy" onerror="this.onerror=null;const p=this.parentElement;if(p){p.style.background=p.dataset.fbBg;p.innerHTML='<span style=&quot;font-size:32px&quot;>'+p.dataset.fbIcon+'</span>';}">`
                  : `<span style="font-size:32px">${fb.icon}</span>`}
                <div class="overview-day-badge">Day ${day}</div>
              </div>
              <div class="overview-day-info">
                <div class="overview-day-name">${escapeHtml(course.name)}</div>
                <div class="overview-day-meta">📍 ${course.spots.length}개소 · 피로도 ${course.total_fatigue} · ${course.distance_km}km</div>
                <div class="overview-day-spots">${course.spots.slice(0, 3).map(s => escapeHtml(s.name)).join(' → ')}${course.spots.length > 3 ? ' ...' : ''}</div>
              </div>
            </div>`;
          }).join('')}
        </div>

        <div class="overview-cta">
          <p class="overview-cta-hint">각 날짜 탭을 선택해서 코스를 골라보세요</p>
        </div>
      </div>`;

    resultList.querySelectorAll('.overview-day-card').forEach(card => {
      card.addEventListener('click', () => {
        const dayIdx = dayHighlights.findIndex(h => h.course.id == card.dataset.courseId);
        if (dayIdx >= 0) {
          activeDay = dayHighlights[dayIdx].day;
          renderDayTabs();
          renderCourses(getFilteredCourses());
          resultList.scrollIntoView({ behavior: 'smooth', block: 'start' });
        }
      });
    });
  }

  function renderCourses(courses) {
    if (loadingState) {
      loadingState.style.display = 'none';
    }

    // 전체 요약 탭 (멀티데이이고 activeDay === 0일 때)
    const totalDays = parseInt(AppState.days, 10) || 1;
    if (totalDays > 1 && activeDay === 0 && courses.length > 0) {
      renderOverviewTab(courses);
      return;
    }

    resultList.innerHTML = '';

    if (courses.length === 0) {
      renderEmptyState();
      return;
    }

    // 멀티데이: Day별 그룹 헤더 삽입
    const days = AppState.days || 1;
    const dayLabels = { 1: '첫째 날', 2: '둘째 날', 3: '셋째 날', 4: '넷째 날', 5: '다섯째 날' };
    let lastDay = 0;
    const dayCounts = new Map();
    courses.forEach(function (c) { dayCounts.set(c.day, (dayCounts.get(c.day) || 0) + 1); });

    courses.forEach(function (course) {
      if (days > 1 && course.day && course.day !== lastDay) {
        lastDay = course.day;
        const header = document.createElement('div');
        header.className = 'day-group-header';
        header.setAttribute('role', 'heading');
        header.setAttribute('aria-level', '2');
        header.innerHTML = `
          <span class="day-group-badge">Day ${course.day}</span>
          <span class="day-group-label">${dayLabels[course.day] || course.day + '일차'}</span>
          <span class="day-group-count">${dayCounts.get(course.day) || 0}개 코스</span>`;
        resultList.appendChild(header);
      }
      const spotsNames = course.spots.map(s => escapeHtml(s.name)).join(' → ');
      const avgGrade = course.accessibility_avg || 3;
      const gradeText = gradeLabel(Math.round(avgGrade));
      const wheelchairStatus = course.spots.some(s => s.wheelchair_accessible === false) ? 'fail'
        : course.spots.some(s => s.wheelchair_accessible === true) ? 'ok' : 'unknown';
      const strollerStatus = course.spots.some(s => s.stroller_accessible === false) ? 'fail'
        : course.spots.some(s => s.stroller_accessible === true) ? 'ok' : 'unknown';
      const restroomStatus = course.spots.some(s => s.restroom_accessible === false) ? 'fail'
        : course.spots.some(s => s.restroom_accessible === true) ? 'ok' : 'unknown';
      const hasElevator = course.spots.some(s => s.elevator);
      const accessChecks = [];
      const fatigueClass = course.total_fatigue <= 50 ? 'badge-green'
        : course.total_fatigue <= 80 ? 'badge-orange'
        : 'badge-red';
      const isFav = AppFavorites.has(course.id);
      const thumbUrl = course.spots[0] && course.spots[0].image_url;

      accessChecks.push(wheelchairStatus === 'ok' ? { label: '✓ 휠체어 OK', ok: true, status: 'ok' }
        : wheelchairStatus === 'fail' ? { label: '✗ 휠체어 제한', ok: false, status: 'fail' }
        : { label: '? 휠체어 미확인', ok: false, status: 'unknown' });
      accessChecks.push(strollerStatus === 'ok' ? { label: '✓ 유아차 OK', ok: true, status: 'ok' }
        : strollerStatus === 'fail' ? { label: '✗ 유아차 제한', ok: false, status: 'fail' }
        : { label: '? 유아차 미확인', ok: false, status: 'unknown' });
      accessChecks.push(restroomStatus === 'ok' ? { label: '✓ 장애인화장실', ok: true, status: 'ok' }
        : restroomStatus === 'fail' ? { label: '✗ 화장실 제한', ok: false, status: 'fail' }
        : { label: '? 화장실 미확인', ok: false, status: 'unknown' });
      if (hasElevator) accessChecks.push({ label: '✓ 엘리베이터', ok: true, status: 'ok' });

      const card = document.createElement('article');
      card.className = 'course-card';
      card.setAttribute('role', 'button');
      card.setAttribute('tabindex', '0');
      card.setAttribute('aria-label', `${course.name} 코스 상세 보기`);
      const fallback = getCategoryFallback(course);
      card.innerHTML = `
        <div class="course-card-thumb${thumbUrl ? '' : ' course-card-thumb--placeholder'}" data-fb-bg="${escapeHtml(fallback.bg)}" data-fb-icon="${escapeHtml(fallback.icon)}" style="height:${thumbUrl ? '140' : '80'}px;overflow:hidden;position:relative;${thumbUrl ? '' : `background:${fallback.bg};display:flex;align-items:center;justify-content:center;`}">
          ${thumbUrl
            ? `<img src="${escapeHtml(thumbUrl)}" alt="${escapeHtml(course.spots[0].name)}" loading="lazy" style="width:100%;height:100%;object-fit:cover;display:block;transition:transform 0.4s ease" onerror="this.onerror=null;const fb=this.closest('.course-card-thumb');if(fb){fb.style.background=fb.dataset.fbBg;fb.innerHTML='<div class=&quot;course-thumb-fallback&quot; style=&quot;font-size:28px&quot;>'+fb.dataset.fbIcon+'</div>';}">`
            : `<div class="course-thumb-fallback" style="font-size:28px">${fallback.icon}</div>`}
          <div style="position:absolute;inset:0;background:linear-gradient(180deg,transparent 40%,rgba(0,0,0,0.45) 100%)"></div>
          <div style="position:absolute;bottom:8px;left:12px;display:flex;gap:6px;flex-wrap:wrap">
            <span class="badge badge-blue" style="backdrop-filter:blur(4px);background:rgba(235,240,248,0.9)">📍 ${course.spots.length}개소</span>
            <span class="badge ${fatigueClass}" style="backdrop-filter:blur(4px)">피로도 ${course.total_fatigue}</span>
          </div>
        </div>
        <div class="course-card-header">
          <div class="course-card-top">
            <div class="access-grade">
              <span class="access-label">${gradeText}</span>
              <div class="access-progress-wrap">
                <div class="access-progress-bar" aria-label="접근성 등급 ${gradeText}" title="${gradeText}">
                  <div class="access-progress-fill grade-${Math.round(avgGrade)}"></div>
                </div>
              </div>
            </div>
            <div class="course-card-top-right">
              <button class="fav-btn" aria-label="즐겨찾기" data-id="${course.id}">${isFav ? '♥' : '♡'}</button>
            </div>
          </div>
          <div class="course-name">${escapeHtml(course.name)}</div>
          <div class="course-stops">${spotsNames}</div>
        </div>
        ${course.ai_description ? `
        <div class="course-ai-block">
          <span class="course-ai-label">✦ 추천 이유</span>
          <p class="course-ai-desc">${escapeHtml(course.ai_description)}</p>
          ${course.ai_highlights?.length ? `<div class="course-ai-chips">${course.ai_highlights.map(h=>`<span class="ai-chip">${escapeHtml(h)}</span>`).join('')}</div>` : ''}
          ${course.ai_tip ? `<div class="course-ai-tip">💡 ${escapeHtml(course.ai_tip)}</div>` : ''}
        </div>` : ''}
        <div class="course-meta">
          <div class="course-meta-item">
            <span class="ico" aria-hidden="true">⏱</span>
            <span>약 <strong>${course.total_time_min}분</strong></span>
          </div>
          <div class="course-meta-item">
            <span class="ico" aria-hidden="true">📏</span>
            <span><strong>${course.distance_km}km</strong></span>
          </div>
          <div class="course-meta-item">
            <span class="ico" aria-hidden="true">🚻</span>
            <span>쉼터 <strong>${course.rest_spots}</strong></span>
          </div>
        </div>
        <div class="course-access-checks">
          ${accessChecks.map(check =>
            `<span class="check-chip ${check.status === 'ok' ? '' : check.status === 'unknown' ? 'unknown' : 'warn'}">${check.label}${check.status === 'unknown' ? '<span class="check-chip-info" title="TourAPI에 접근성 정보가 없는 장소입니다. 방문 전 확인 권장">&#8505;</span>' : ''}</span>`
          ).join('')}
        </div>
        <div class="course-card-footer">
          <span class="source">${course.ai_description ? '공공데이터 기반 추천 이유' : '공공데이터 기반 추천'}</span>
          <span class="arrow" aria-hidden="true">→</span>
        </div>`;

      const favBtn = card.querySelector('.fav-btn');
      favBtn.addEventListener('click', function (e) {
        e.stopPropagation();
        const added = AppFavorites.toggle(course.id);
        favBtn.textContent = added ? '♥' : '♡';
        favBtn.style.color = added ? 'var(--primary)' : '';
        logInteraction('favorite_toggle', { course_id: course.id, action: added ? 'add' : 'remove' });
        if (activeFilter === 'favorites') {
          renderCurrentFilter();
        }
      });
      if (isFav) {
        favBtn.style.color = 'var(--primary)';
      }

      card.addEventListener('click', function () {
        logInteraction('course_view', {
          course_id: course.id,
          course_name: course.name,
          course_rank: courses.indexOf(course),
          filter_active: activeFilter,
          day_active: activeDay,
          ai_description: !!course.ai_description,
        });
        AppState.selected_course = course;
        navigateTo('/course.html?id=' + course.id);
      });
      card.addEventListener('keydown', function (e) {
        if (e.key === 'Enter') card.click();
      });

      resultList.appendChild(card);
    });
  }

  function renderCurrentFilter() {
    updateFilterTabs();
    renderDayTabs();
    const filtered = getFilteredCourses();
    renderSummary(filtered);
    renderCourses(filtered);
    // 현재 필터/탭 결과의 모든 스팟을 지도에 표시 (비동기 업데이트)
    updateResultMap(filtered);
  }

  function showRetryError() {
    hideSkeletons();
    resultList.innerHTML = `
      <div class="empty-state">
        <div class="icon" aria-hidden="true">⚠️</div>
        <h3>추천 결과를 불러오지 못했습니다</h3>
        <p>네트워크 연결을 확인하고 다시 시도해주세요.</p>
        <button class="btn-outline" id="retryBtn" style="width:auto;padding:0 24px;margin-top:8px">다시 시도</button>
      </div>`;
    const retryBtn = document.getElementById('retryBtn');
    if (retryBtn) {
      retryBtn.addEventListener('click', function () {
        rerunRecommendations();
      });
    }
  }

  async function rerunRecommendations() {
    showSkeletons();
    const result = await requestRecommendations();
    if (!result?.courses?.length) {
      showRetryError();
      return;
    }
    hideSkeletons();
    allCourses = result.courses;
    renderCurrentFilter();
    showToast('추천 결과를 최신 조건으로 다시 분석했어요.', 'success');
    if (result.summary?.fallback_used) {
      showToast('선택 지역에 코스가 부족해 인근 지역을 포함했어요', 'info');
    }
    // 추천 요청 로그 저장 (fire-and-forget, 실패해도 UX 영향 없음)
    if (typeof logRecommendationSilent === 'function') {
      logRecommendationSilent(result).catch(() => {});
    }
    // 만족도 조사는 course.html에서 처리
  }

  async function init() {
    const stored = AppState.courses || [];

    if (stored.length === 0) {
      if (!hasRecommendationContext()) {
        if (loadingState) {
          loadingState.innerHTML = `
            <div class="empty-state">
              <div class="icon" aria-hidden="true">🔍</div>
              <h3>추천 결과가 없습니다</h3>
              <p>온보딩을 먼저 완료해주세요.<br>조건에 맞는 관광지가 없을 수도 있습니다.</p>
              <button class="btn-outline" style="width:auto;padding:0 24px;margin-top:8px" onclick="navigateTo('/onboarding.html')">다시 설정하기</button>
            </div>`;
        }
        renderSummary([]);
        return;
      }
      await rerunRecommendations();
      return;
    }

    allCourses = stored;
    renderCurrentFilter();
    if (AppState.recommendation_meta?.fallback_used) {
      showToast('선택 지역에 코스가 부족해 인근 지역을 포함했어요', 'info');
    }
    // 만족도 조사는 course.html에서 처리
  }

  // ── 만족도 조사 블록 ─────────────────────────────────
  function setupSatisfactionBlock() {
    const block = document.getElementById('satisfactionBlock');
    if (!block || !allCourses.length) return;
    // 이미 제출한 세션이면 노출 금지
    if (sessionStorage.getItem('mb_survey_done') === '1') {
      block.hidden = true;
      return;
    }
    // 초기화 (이미 바인딩된 경우 중복 방지)
    if (block.dataset.bound === '1') {
      block.hidden = false;
      return;
    }
    block.dataset.bound = '1';
    block.hidden = false;

    const scaleEl = document.getElementById('satisfactionScale');
    const panelEl = document.getElementById('satisfactionReasonPanel');
    const chipsEl = document.getElementById('satisfactionReasonChips');
    const textEl = document.getElementById('satisfactionText');
    const countEl = document.getElementById('satisfactionCharCount');
    const submitEl = document.getElementById('satisfactionSubmit');
    const skipEl = document.getElementById('satisfactionSkip');
    const doneEl = document.getElementById('satisfactionDone');

    let selectedScore = 0;

    function openReasonPanel(open) {
      if (!panelEl) return;
      if (open) {
        panelEl.classList.add('open');
        panelEl.setAttribute('aria-hidden', 'false');
      } else {
        panelEl.classList.remove('open');
        panelEl.setAttribute('aria-hidden', 'true');
      }
    }

    if (scaleEl) {
      scaleEl.querySelectorAll('.satisfaction-btn').forEach(btn => {
        btn.addEventListener('click', function () {
          const score = parseInt(this.dataset.score, 10);
          selectedScore = score;
          scaleEl.querySelectorAll('.satisfaction-btn').forEach(b => {
            b.setAttribute('aria-checked', b === this ? 'true' : 'false');
          });
          if (submitEl) submitEl.disabled = false;
          openReasonPanel(score <= 2);
        });
      });
    }

    if (chipsEl) {
      chipsEl.querySelectorAll('.satisfaction-reason-chip').forEach(chip => {
        chip.addEventListener('click', function () {
          const pressed = this.getAttribute('aria-pressed') === 'true';
          this.setAttribute('aria-pressed', pressed ? 'false' : 'true');
        });
      });
    }

    if (textEl && countEl) {
      textEl.addEventListener('input', function () {
        countEl.textContent = String(this.value.length);
      });
    }

    if (submitEl) {
      submitEl.addEventListener('click', async function () {
        if (!selectedScore) return;
        submitEl.disabled = true;
        const selectedReasons = chipsEl
          ? Array.from(chipsEl.querySelectorAll('.satisfaction-reason-chip[aria-pressed="true"]'))
              .map(c => c.dataset.reason)
          : [];
        const text = textEl ? textEl.value.trim() : '';
        const res = typeof submitSatisfactionSurvey === 'function'
          ? await submitSatisfactionSurvey(selectedScore, selectedReasons, text)
          : { ok: false };
        if (res && res.ok) {
          sessionStorage.setItem('mb_survey_done', '1');
          if (scaleEl) scaleEl.style.display = 'none';
          openReasonPanel(false);
          if (document.querySelector('.satisfaction-actions')) {
            document.querySelector('.satisfaction-actions').style.display = 'none';
          }
          if (doneEl) doneEl.hidden = false;
        } else {
          submitEl.disabled = false;
          showToast('의견 저장에 실패했어요. 잠시 후 다시 시도해주세요.', 'error');
        }
      });
    }

    if (skipEl) {
      skipEl.addEventListener('click', function () {
        sessionStorage.setItem('mb_survey_done', '1');
        block.hidden = true;
      });
    }
  }

  document.addEventListener('click', function (e) {
    const tab = e.target.closest('[data-filter]');
    if (!tab) return;
    const prev = activeFilter;
    activeFilter = tab.dataset.filter;
    if (prev !== activeFilter) {
      logInteraction('filter_change', { filter_type: activeFilter, previous_filter: prev });
    }
    renderCurrentFilter();
  });

  // Day탭 바는 스크롤 방향에 따른 숨김/표시 애니메이션 없이 항상 고정 표시한다.
  // (이전에는 위/아래 스크롤에 따라 translateY로 숨겼다가 나타나 UX가 어색했다.)
  (function lockDayTabBar() {
    const bar = document.getElementById('dayTabBar');
    if (!bar) return;
    bar.style.transform = 'none';
    bar.style.transition = 'none';
  })();

  init();
})();
