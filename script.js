// =========================
// CONFIG
// =========================
const ALPHA_VANTAGE_KEY = "A2ETSXLOGFIEWP5Y";
const ALPHA_VANTAGE_BASE = "https://www.alphavantage.co/query";

const BENCHMARK_SYMBOLS = {
  spy: "SPY",
  dia: "DIA",
  qqq: "QQQ",
};

// Simple in-memory cache so we don't smash the free rate limits
const priceCache = new Map();

// Portfolio state
let portfolio = [];
let portfolioChart = null;
let searchChart = null;
let currentSearchSymbol = null;

// =========================
// UTILS
// =========================
function $(selector) {
  return document.querySelector(selector);
}

function createEl(tag, className, text) {
  const el = document.createElement(tag);
  if (className) el.className = className;
  if (text !== undefined) el.textContent = text;
  return el;
}

async function fetchJson(url) {
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`HTTP ${res.status}`);
  }

  const data = await res.json();

  // Alpha Vantage puts rate-limit and other errors in these fields
  const apiMessage = data.Note || data.Information || data["Error Message"];
  if (apiMessage) {
    console.error("Alpha Vantage error:", apiMessage);
    throw new Error(apiMessage);
  }

  return data;
}


function formatDateLabel(dateStr) {
  // dateStr is "YYYY-MM-DD"
  return dateStr;
}

// Rough util: default to last 90 days if no dates are selected
function deriveDateRange(startInput, endInput, availableDates) {
  if (!availableDates || availableDates.length === 0) {
    return { start: null, end: null };
  }

  const sortedDates = [...availableDates].sort(); // "YYYY-MM-DD" works lexicographically
  const minDate = sortedDates[0];
  const maxDate = sortedDates[sortedDates.length - 1];

  let start = startInput.value || null;
  let end = endInput.value || null;

  // If user cleared inputs, fall back to default 90-day window
  if (!end) {
    end = maxDate;
  }
  if (!start) {
    const ninetyBackIndex = Math.max(sortedDates.length - 1 - 90, 0);
    start = sortedDates[ninetyBackIndex];
  }

  // Clamp to available data range
  if (start < minDate) start = minDate;
  if (end > maxDate) end = maxDate;

  // If user reversed them (start > end), swap
  if (start > end) {
    const tmp = start;
    start = end;
    end = tmp;
  }

  // Write back to the inputs so the UI always shows a valid range
  startInput.value = start;
  endInput.value = end;

  return { start, end };
}


// =========================
// NAVIGATION
// =========================
function initNavigation() {
  const tabs = document.querySelectorAll(".nav-tab");
  const pages = document.querySelectorAll(".page");

  tabs.forEach((tab) => {
    tab.addEventListener("click", () => {
      const targetId = tab.dataset.target;

      tabs.forEach((t) => t.classList.toggle("nav-tab--active", t === tab));
      pages.forEach((page) => {
        const active = page.id === targetId;
        page.classList.toggle("page--active", active);
        page.hidden = !active;
      });

      if (targetId === "news-page") {
        refreshNewsPage();
      }
    });
  });
}

// =========================
// PORTFOLIO: LOCAL STORAGE
// =========================
function loadPortfolioFromStorage() {
  try {
    const raw = localStorage.getItem("portfolioTickers");
    if (!raw) return;
    const arr = JSON.parse(raw);
    if (Array.isArray(arr)) {
      portfolio = arr;
    }
  } catch (e) {
    console.warn("Unable to read portfolio from storage", e);
  }
}

function savePortfolioToStorage() {
  localStorage.setItem("portfolioTickers", JSON.stringify(portfolio));
}

// =========================
// PORTFOLIO: UI
// =========================
function renderPortfolioList() {
  const list = $("#portfolio-list");
  list.innerHTML = "";

  if (portfolio.length === 0) {
    const empty = createEl("li", "muted tiny", "No tickers yet. Add one above to begin.");
    list.appendChild(empty);
    return;
  }

  portfolio.forEach((symbol) => {
    const li = createEl("li", "chip");
    const span = createEl("span", "chip-symbol", symbol);
    const removeBtn = createEl("button", "chip-remove", "×");
    removeBtn.setAttribute("type", "button");
    removeBtn.setAttribute("aria-label", `Remove ${symbol} from portfolio`);
    removeBtn.addEventListener("click", () => {
      portfolio = portfolio.filter((s) => s !== symbol);
      savePortfolioToStorage();
      renderPortfolioList();
      updatePortfolioChart();
      // news will be refreshed when user visits news tab
    });
    li.append(span, removeBtn);
    list.appendChild(li);
  });
}

// =========================
// ALPHA VANTAGE CALLS
// =========================
async function fetchDailySeries(symbol) {
  const key = `DAILY_${symbol.toUpperCase()}`;
  if (priceCache.has(key)) return priceCache.get(key);

  // Match your old working code: TIME_SERIES_DAILY instead of DAILY_ADJUSTED
  const url = `${ALPHA_VANTAGE_BASE}?function=TIME_SERIES_DAILY&symbol=${encodeURIComponent(
    symbol
  )}&outputsize=compact&apikey=${ALPHA_VANTAGE_KEY}`;

  const data = await fetchJson(url);

  const seriesKey = Object.keys(data).find((k) =>
    k.toLowerCase().includes("time series (daily")
  );

  if (!seriesKey) {
    console.error("No daily series in response for", symbol, data);
    throw new Error(`Unexpected daily series response for ${symbol}`);
  }

  const seriesObj = data[seriesKey];
  const rows = Object.entries(seriesObj).map(([date, values]) => ({
    date,
    close: parseFloat(values["4. close"] || "0"),
  }));

  const sorted = rows
    .filter((row) => !Number.isNaN(row.close))
    .sort((a, b) => (a.date < b.date ? -1 : 1));

  priceCache.set(key, sorted);
  return sorted;
}


async function fetchGlobalQuote(symbol) {
  const url = `${ALPHA_VANTAGE_BASE}?function=GLOBAL_QUOTE&symbol=${encodeURIComponent(
    symbol
  )}&apikey=${ALPHA_VANTAGE_KEY}`;
  const data = await fetchJson(url);
  return data["Global Quote"] || {};
}

async function fetchOverview(symbol) {
  const url = `${ALPHA_VANTAGE_BASE}?function=OVERVIEW&symbol=${encodeURIComponent(
    symbol
  )}&apikey=${ALPHA_VANTAGE_KEY}`;
  return fetchJson(url);
}

async function symbolSearch(query) {
  const url = `${ALPHA_VANTAGE_BASE}?function=SYMBOL_SEARCH&keywords=${encodeURIComponent(
    query
  )}&apikey=${ALPHA_VANTAGE_KEY}`;
  const data = await fetchJson(url);
  const matches = data["bestMatches"] || [];
  if (!matches.length) return null;

  const best = matches[0];
  return {
    symbol: best["1. symbol"],
    name: best["2. name"],
    region: best["4. region"],
  };
}

async function fetchNews({ tickers, topics, limit = 20 }) {
  const params = new URLSearchParams({
    function: "NEWS_SENTIMENT",
    apikey: ALPHA_VANTAGE_KEY,
  });
  if (tickers && tickers.length) {
    params.set("tickers", tickers.join(","));
  }
  if (topics && topics.length) {
    params.set("topics", topics.join(","));
  }
  params.set("sort", "LATEST");
  params.set("limit", String(limit));

  const url = `${ALPHA_VANTAGE_BASE}?${params.toString()}`;
  const data = await fetchJson(url);
  return data.feed || [];
}

// =========================
// PERFORMANCE CALCULATIONS
// =========================
function sliceSeriesByDate(series, startDate, endDate) {
  return series.filter((row) => row.date >= startDate && row.date <= endDate);
}

function normalizeSeries(series) {
  if (!series.length) return [];
  const base = series[0].close;
  return series.map((row) => ({
    date: row.date,
    value: (row.close / base) * 100,
  }));
}

async function buildDataset(symbol, startDate, endDate, label, color) {
  const rawSeries = await fetchDailySeries(symbol);
  const sliced = sliceSeriesByDate(rawSeries, startDate, endDate);
  const norm = normalizeSeries(sliced);
  return {
    label: label || symbol.toUpperCase(),
    data: norm.map((row) => row.value),
    borderColor: color,
    backgroundColor: "transparent",
    borderWidth: 2,
    pointRadius: 0,
    tension: 0.25,
  };
}

async function buildPortfolioDataset(startDate, endDate, color) {
  if (!portfolio.length) return null;

  // Fetch all series
  const allSeries = await Promise.all(portfolio.map((s) => fetchDailySeries(s)));

  // Use dates from the first ticker as the canonical set
  const baseSeries = sliceSeriesByDate(allSeries[0], startDate, endDate);
  if (!baseSeries.length) return null;

  const dates = baseSeries.map((row) => row.date);

  // Create lookup maps for others
  const maps = allSeries.map((series) => {
    const sliced = sliceSeriesByDate(series, startDate, endDate);
    const map = new Map();
    sliced.forEach((row) => map.set(row.date, row.close));
    return map;
  });

  const values = [];
  dates.forEach((date) => {
    const closes = maps
      .map((m) => m.get(date))
      .filter((v) => v !== undefined && !Number.isNaN(v));
    if (closes.length !== portfolio.length) return; // skip if missing data

    if (!values.length) {
      // set base value
      values.push({ date, base: closes });
    } else {
      values.push({ date, base: closes });
    }
  });

  if (!values.length) return null;

  const basePrices = values[0].base;
  const datasetValues = values.map((row) => {
    const rets = row.base.map((p, idx) => p / basePrices[idx]);
    const avg = rets.reduce((sum, r) => sum + r, 0) / rets.length;
    return avg * 100;
  });

  return {
    label: "Portfolio",
    data: datasetValues,
    borderColor: color,
    backgroundColor: "transparent",
    borderWidth: 2.4,
    pointRadius: 0,
    tension: 0.25,
  };
}

// =========================
// PORTFOLIO CHART
// =========================
async function updatePortfolioChart() {
  const status = $("#portfolio-status");
  const startInput = $("#portfolio-start");
  const endInput = $("#portfolio-end");

  status.textContent = "Loading data…";

  try {
    // figure out available dates by picking SPY (broad market calendar)
    const spySeries = await fetchDailySeries(BENCHMARK_SYMBOLS.spy);
    const availableDates = spySeries.map((row) => row.date);

    const { start, end } = deriveDateRange(startInput, endInput, availableDates);
    if (!start || !end) {
      status.textContent = "Not enough data yet.";
      return;
    }

    const labels = sliceSeriesByDate(spySeries, start, end).map((row) =>
      formatDateLabel(row.date)
    );

    const datasets = [];

    // portfolio dataset
    if (portfolio.length) {
      const portfolioDs = await buildPortfolioDataset(
        start,
        end,
        "rgba(191, 215, 255, 1)"
      );
      if (portfolioDs) datasets.push(portfolioDs);
    }

    // Benchmarks
    const benchColors = {
      spy: "rgba(127, 180, 255, 1)",
      dia: "rgba(156, 219, 186, 1)",
      qqq: "rgba(241, 184, 255, 1)",
    };

    const benchChecks = {
      spy: $("#bench-spy").checked,
      dia: $("#bench-dia").checked,
      qqq: $("#bench-qqq").checked,
    };

    for (const [key, symbol] of Object.entries(BENCHMARK_SYMBOLS)) {
      if (!benchChecks[key]) continue;
      const color = benchColors[key];
      const dataset = await buildDataset(symbol, start, end, symbol, color);
      datasets.push(dataset);
    }

    if (portfolioChart) {
      portfolioChart.destroy();
    }

    const ctx = document.getElementById("portfolio-chart").getContext("2d");
    portfolioChart = new Chart(ctx, {
      type: "line",
      data: {
        labels,
        datasets,
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: {
          legend: {
            labels: {
              color: "#cdd3eb",
              font: {
                family: "Space Grotesk",
                size: 11,
              },
            },
          },
          tooltip: {
            mode: "index",
            intersect: false,
          },
        },
        interaction: {
          mode: "index",
          intersect: false,
        },
        scales: {
          x: {
            ticks: { color: "#848ca3", maxTicksLimit: 7 },
            grid: { color: "rgba(255,255,255,0.05)" },
          },
          y: {
            ticks: { color: "#848ca3" },
            grid: { color: "rgba(255,255,255,0.05)" },
          },
        },
      },
    });

    if (!portfolio.length) {
      status.textContent =
        "Add a few tickers to see portfolio performance alongside the indices.";
    } else {
      status.textContent = "";
    }
  } catch (e) {
    console.error(e);
    status.textContent =
      "There was a problem loading data (possibly hitting the free API limit). Try again later.";
  }
}

// =========================
// NEWS PAGE
// =========================
async function refreshNewsPage() {
  const portfolioNewsContainer = $("#portfolio-news");
  const portfolioStatus = $("#portfolio-news-status");
  const marketNewsContainer = $("#market-news");
  const marketStatus = $("#market-news-status");

  // Portfolio news
  // Portfolio news
  portfolioNewsContainer.innerHTML = "";
  if (!portfolio.length) {
    portfolioStatus.textContent =
      "Add tickers to your portfolio to see related headlines.";
  } else {
    portfolioStatus.textContent = "Loading headlines for your holdings…";
    try {
      // Only use the first few tickers to avoid smashing the free tier
      const tickersToUse = portfolio.slice(0, 3);

      let mergedArticles = [];

      for (const symbol of tickersToUse) {
        // Fetch per-ticker – Alpha Vantage behaves better this way
        const articlesForSymbol = await fetchNews({
          tickers: [symbol],
          limit: 8, // a few per ticker, we’ll trim later
        });
        mergedArticles = mergedArticles.concat(articlesForSymbol || []);
      }

      // Optional: sort by time_published descending
      mergedArticles.sort((a, b) => {
        const ta = a.time_published || "";
        const tb = b.time_published || "";
        return tb.localeCompare(ta);
      });

      // Cap at 20 total
      mergedArticles = mergedArticles.slice(0, 20);

      renderNewsCards(portfolioNewsContainer, mergedArticles);
      portfolioStatus.textContent =
        mergedArticles.length === 0 ? "No recent portfolio headlines found." : "";
    } catch (e) {
      console.error(e);
      portfolioStatus.textContent = "Unable to load portfolio news right now.";
    }
  }


  // Market news
  marketNewsContainer.innerHTML = "";
  marketStatus.textContent = "Loading market stories…";
  try {
    const articles = await fetchNews({
      topics: ["financial_markets", "economy_macro"],
      limit: 20,
    });
    renderNewsCards(marketNewsContainer, articles);
    marketStatus.textContent =
      articles.length === 0 ? "No recent market stories found." : "";
  } catch (e) {
    console.error(e);
    marketStatus.textContent = "Unable to load market news right now.";
  }
}

function createNewsCard(article) {
  const card = createEl("article", "news-card");

  const title = createEl("h3", "news-title");
  title.textContent = article.title || "Untitled story";

  const meta = createEl("div", "news-meta");
  const source = article.source || article.source_domain || "Unknown source";
  const ts = article.time_published || "";
  const date = ts ? `${ts.slice(0, 4)}-${ts.slice(4, 6)}-${ts.slice(6, 8)}` : "";
  meta.textContent = `${source}${date ? " • " + date : ""}`;

  const tag = createEl(
    "span",
    "news-tag",
    (article.overall_sentiment_label || "Neutral").toUpperCase()
  );

  const summary = createEl(
    "p",
    "muted tiny",
    article.summary || article.snippet || ""
  );

  const link = createEl("a", "news-link", "Open article ↗");
  link.href = article.url || "#";
  link.target = "_blank";
  link.rel = "noopener noreferrer";

  card.append(title, meta, tag, summary, link);
  return card;
}

function renderNewsCards(container, articles) {
  container.innerHTML = "";
  if (!articles || !articles.length) return;

  const MAX_TOTAL = 20;      // still only ever show up to 20
  const INITIAL_VISIBLE = 8; // first load: 8 cards

  const trimmed = articles.slice(0, MAX_TOTAL);
  let visibleCount = Math.min(INITIAL_VISIBLE, trimmed.length);

  function renderSlice() {
    container.innerHTML = "";

    // Render currently visible cards
    trimmed.slice(0, visibleCount).forEach((article) => {
      const card = createNewsCard(article);
      container.appendChild(card);
    });

    // If there are more, show the "Show more" button
    if (visibleCount < trimmed.length) {
      const wrapper = createEl("div", "news-more-wrapper");
      const btn = createEl("button", "btn btn--ghost news-more-btn", "Show more");
      btn.type = "button";

      btn.addEventListener("click", () => {
        // When clicked, reveal the rest of the cards
        visibleCount = trimmed.length;
        renderSlice();
      });

      wrapper.appendChild(btn);
      container.appendChild(wrapper);
    }
  }

  renderSlice();
}


// =========================
// SEARCH PAGE
// =========================
async function handleSearchSubmit(event) {
  event.preventDefault();
  const query = $("#search-input").value.trim();
  if (!query) return;

  const titleEl = $("#search-result-title");
  const subtitleEl = $("#search-result-subtitle");
  const statsGrid = $("#company-stats");
  const status = $("#search-status");
  const newsSubtitle = $("#search-news-subtitle");
  const newsContainer = $("#search-news");
  const newsStatus = $("#search-news-status");

  statsGrid.innerHTML = "";
  newsContainer.innerHTML = "";
  status.textContent = "Searching…";
  newsStatus.textContent = "";

  try {
    // Heuristic: if user typed a short all-caps string, treat as ticker.
    let symbolGuess = null;
    let nameGuess = null;

    if (/^[a-zA-Z.\-]{1,6}$/.test(query)) {
      symbolGuess = query.toUpperCase();
    } else {
      const match = await symbolSearch(query);
      if (!match) {
        status.textContent = "No matching ticker found.";
        return;
      }
      symbolGuess = match.symbol.toUpperCase();
      nameGuess = match.name;
    }

    currentSearchSymbol = symbolGuess;

    const [overview, quote] = await Promise.all([
      fetchOverview(symbolGuess),
      fetchGlobalQuote(symbolGuess),
    ]);

    const companyName = overview.Name || nameGuess || symbolGuess;
    titleEl.textContent = companyName;
    subtitleEl.textContent = `${symbolGuess} • ${
      overview.Sector || "Unknown sector"
    } • ${overview.Industry || "Unknown industry"}`;

    // Fill stats
    const stats = [
      {
        label: "Price",
        value: `$${parseFloat(quote["05. price"] || quote["05. Price"] || 0).toFixed(
          2
        )}`,
      },
      {
        label: "Market Cap",
        value: overview.MarketCapitalization
          ? `$${Number(overview.MarketCapitalization).toLocaleString()}`
          : "—",
      },
      { label: "P/E", value: overview.PERatio || "—" },
      { label: "EPS", value: overview.EPS || "—" },
      { label: "Beta", value: overview.Beta || "—" },
      { label: "Dividend Yield", value: overview.DividendYield || "—" },
      { label: "52w High", value: overview["52WeekHigh"] || "—" },
      { label: "52w Low", value: overview["52WeekLow"] || "—" },
    ];

    stats.forEach(({ label, value }) => {
      const dt = createEl("dt", null, label);
      const dd = createEl("dd", null, value);
      const row = createEl("div", "stat-row");
      row.append(dt, dd);
      statsGrid.append(row);
    });

    // Performance chart
    await updateSearchChart();

    // News for ticker
    newsSubtitle.textContent = `Headlines mentioning ${symbolGuess}.`;
    newsStatus.textContent = "Loading headlines…";
    try {
      const articles = await fetchNews({ tickers: [symbolGuess], limit: 20 });
      renderNewsCards(newsContainer, articles);
      newsStatus.textContent = articles.length ? "" : "No recent headlines found.";
    } catch (e) {
      console.error(e);
      newsStatus.textContent = "Unable to load news for this ticker.";
    }

    status.textContent = "";
  } catch (e) {
    console.error(e);
    $("#search-status").textContent =
      "There was a problem searching (free API limits are easy to hit). Try again later.";
  }
}

async function updateSearchChart() {
  const status = $("#search-status");
  const startInput = $("#search-start");
  const endInput = $("#search-end");

  if (!currentSearchSymbol) {
    status.textContent = "Search for a ticker to see its performance.";
    return;
  }

  status.textContent = "Loading chart…";

  try {
    const spySeries = await fetchDailySeries(BENCHMARK_SYMBOLS.spy);
    const availableDates = spySeries.map((row) => row.date);
    const { start, end } = deriveDateRange(startInput, endInput, availableDates);

    const labels = sliceSeriesByDate(spySeries, start, end).map((row) =>
      formatDateLabel(row.date)
    );

    const datasets = [];

    // Main stock
    const stockDataset = await buildDataset(
      currentSearchSymbol,
      start,
      end,
      currentSearchSymbol,
      "rgba(191, 215, 255, 1)"
    );
    datasets.push(stockDataset);

    const benchColors = {
      spy: "rgba(127, 180, 255, 1)",
      dia: "rgba(156, 219, 186, 1)",
      qqq: "rgba(241, 184, 255, 1)",
    };
    const benchChecks = {
      spy: $("#search-bench-spy").checked,
      dia: $("#search-bench-dia").checked,
      qqq: $("#search-bench-qqq").checked,
    };

    for (const [key, symbol] of Object.entries(BENCHMARK_SYMBOLS)) {
      if (!benchChecks[key]) continue;
      const dataset = await buildDataset(symbol, start, end, symbol, benchColors[key]);
      datasets.push(dataset);
    }

    if (searchChart) {
      searchChart.destroy();
    }

    const ctx = document.getElementById("search-chart").getContext("2d");
    searchChart = new Chart(ctx, {
      type: "line",
      data: { labels, datasets },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: {
          legend: {
            labels: {
              color: "#cdd3eb",
              font: { family: "Space Grotesk", size: 11 },
            },
          },
          tooltip: { mode: "index", intersect: false },
        },
        interaction: { mode: "index", intersect: false },
        scales: {
          x: {
            ticks: { color: "#848ca3", maxTicksLimit: 7 },
            grid: { color: "rgba(255,255,255,0.05)" },
          },
          y: {
            ticks: { color: "#848ca3" },
            grid: { color: "rgba(255,255,255,0.05)" },
          },
        },
      },
    });

    status.textContent = "";
  } catch (e) {
    console.error(e);
    status.textContent =
      "There was a problem loading performance data for this ticker.";
  }
}

// =========================
// INIT
// =========================
document.addEventListener("DOMContentLoaded", () => {
  if (!ALPHA_VANTAGE_KEY || ALPHA_VANTAGE_KEY === "YOUR_ALPHA_VANTAGE_API_KEY_HERE") {
    console.warn("Remember to set your Alpha Vantage API key in script.js.");
  }

  initNavigation();
  loadPortfolioFromStorage();
  renderPortfolioList();
  updatePortfolioChart();

  // Portfolio add form
  $("#add-position-form").addEventListener("submit", (e) => {
    e.preventDefault();
    const input = $("#ticker-input");
    const raw = input.value.trim();
    if (!raw) return;

    // Basic ticker normalization
    const symbol = raw.toUpperCase();

    if (!/^[A-Z.\-]{1,6}$/.test(symbol)) {
      alert("Please enter a simple ticker symbol like AAPL or MSFT.");
      return;
    }

    if (!portfolio.includes(symbol)) {
      portfolio.push(symbol);
      savePortfolioToStorage();
      renderPortfolioList();
      updatePortfolioChart();
    }

    input.value = "";
  });

  // Portfolio forms
  $("#portfolio-range-form").addEventListener("submit", (e) => {
    e.preventDefault();
    updatePortfolioChart();
  });

  $("#bench-spy").addEventListener("change", updatePortfolioChart);
  $("#bench-dia").addEventListener("change", updatePortfolioChart);
  $("#bench-qqq").addEventListener("change", updatePortfolioChart);

  // Search
  $("#search-form").addEventListener("submit", handleSearchSubmit);
  $("#search-range-form").addEventListener("submit", (e) => {
    e.preventDefault();
    updateSearchChart();
  });
  $("#search-bench-spy").addEventListener("change", updateSearchChart);
  $("#search-bench-dia").addEventListener("change", updateSearchChart);
  $("#search-bench-qqq").addEventListener("change", updateSearchChart);
});
