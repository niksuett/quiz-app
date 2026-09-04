// ─────────────────────────────────────────────────────────────────────────────
// tools/build-curves.js — builds the questions for "Draw the Curve" (type: curve).
//
//   node tools/build-curves.js            fetch what is missing, rebuild everything
//   node tools/build-curves.js --offline  never touch the network (use the caches only)
//
// What it produces (both committed to git):
//   data/curves-src.json   every fetched series at full resolution, keyed by id.
//                          A small offline cache so the question list can be
//                          re-cut (different years, steps, axes) without the network.
//   content/curves.json    the question list for import.js — each question carries
//                          its own (thinned) series, so the game needs NO network.
//
// Where the numbers come from:
//   • World Bank API      https://api.worldbank.org/v2/country/<ISO3>/indicator/<CODE>?format=json
//   • NOAA Mauna Loa      https://gml.noaa.gov/webdata/ccgg/trends/co2/co2_annmean_mlo.csv
//   • NASA GISTEMP v4     https://data.giss.nasa.gov/gistemp/tabledata_v4/GLB.Ts+dSST.csv
//   • hand-curated lists  (world records, UN membership, census figures …) — typed in below
//
// Raw downloads are cached under tools/raw/curves/ (gitignored) so re-running is
// free. The script is idempotent: it always rewrites the two outputs from scratch.
// ─────────────────────────────────────────────────────────────────────────────
const fs   = require('fs');
const path = require('path');

const ROOT    = path.join(__dirname, '..');
const RAW_DIR = path.join(ROOT, 'tools', 'raw', 'curves');
const OUT_SRC = path.join(ROOT, 'data', 'curves-src.json');
const OUT_QS  = path.join(ROOT, 'content', 'curves.json');
const OFFLINE = process.argv.includes('--offline');

// Load the module once so every generated question is validated with the SAME
// rules import.js will apply later (axis headroom, point count, …).
const curveModule = require(path.join(ROOT, 'games', 'curve.js'));

// ═════════════════════════════════════════════════════════════════════════════
// 1. THE SERIES LIST
//
// Each entry becomes exactly one question. Fields:
//   id             unique key (also the key in data/curves-src.json)
//   src            'wb' (World Bank) | 'noaa' | 'gistemp' | 'manual'
//   country/indicator   World Bank only
//   from, to, step  which years to keep (thinned to ≤ 60 points). Missing years are skipped.
//   scale           multiply raw values by this (e.g. 1e-6 → millions)
//   decimals        rounding of the stored values and of the numbers shown to players
//   question        prompt text: metric, scope, unit and year span
//   yLabel, unit    axis label and the short unit suffix ("bn", "%", "°C")
//   yMin, yMax      axis range. Chosen so the truth uses ~40–80 % of the height and
//                   never sits at the bottom. (validate() insists on 10 % headroom.)
//   knownFraction   share of the x-range revealed to the player before drawing
//   difficulty      1 = everyone knows the shape, 2 = solid, 3 = expert / surprising
//   region          optional continent tag
//   source          credit shown on the reveal
// ═════════════════════════════════════════════════════════════════════════════
const WB  = 'World Bank';
const S = [];   // series specs, filled below in themed blocks

// ── Population ────────────────────────────────────────────────────────────────
S.push(
  { id: 'wld-pop', src: 'wb', country: 'WLD', indicator: 'SP.POP.TOTL', from: 1960, to: 2024, step: 2, scale: 1e-9, decimals: 2,
    question: 'World population, 1960–2024 (billions)', yLabel: 'Population (billions)', unit: 'bn',
    yMin: 0, yMax: 11, knownFraction: 0.25, difficulty: 1, source: WB },
  { id: 'wld-pop-1900', src: 'manual', decimals: 2,
    // 1900–1950: UN / HYDE estimates as published by Our World in Data; 1960+: World Bank
    series: [[1900, 1.65], [1910, 1.78], [1920, 1.91], [1930, 2.09], [1940, 2.31], [1950, 2.50]],
    appendWb: { country: 'WLD', indicator: 'SP.POP.TOTL', from: 1960, to: 2020, step: 10, scale: 1e-9 },
    question: 'World population, 1900–2020, decade by decade (billions)', yLabel: 'Population (billions)', unit: 'bn',
    yMin: 0, yMax: 10, knownFraction: 0.25, difficulty: 2, source: 'Our World in Data (UN / HYDE), World Bank' },
  { id: 'chn-pop', src: 'wb', country: 'CHN', indicator: 'SP.POP.TOTL', from: 1960, to: 2024, step: 2, scale: 1e-6, decimals: 0,
    question: 'Population of China, 1960–2024 (millions)', yLabel: 'Population (millions)', unit: 'm',
    yMin: 0, yMax: 1800, knownFraction: 0.3, difficulty: 2, region: 'asia', source: WB },
  { id: 'ind-pop', src: 'wb', country: 'IND', indicator: 'SP.POP.TOTL', from: 1960, to: 2024, step: 2, scale: 1e-6, decimals: 0,
    question: 'Population of India, 1960–2024 (millions)', yLabel: 'Population (millions)', unit: 'm',
    yMin: 0, yMax: 2000, knownFraction: 0.25, difficulty: 1, region: 'asia', source: WB },
  { id: 'jpn-pop', src: 'wb', country: 'JPN', indicator: 'SP.POP.TOTL', from: 1960, to: 2024, step: 2, scale: 1e-6, decimals: 1,
    question: 'Population of Japan, 1960–2024 (millions)', yLabel: 'Population (millions)', unit: 'm',
    yMin: 70, yMax: 150, knownFraction: 0.25, difficulty: 2, region: 'asia', source: WB },
  { id: 'nga-pop', src: 'wb', country: 'NGA', indicator: 'SP.POP.TOTL', from: 1960, to: 2024, step: 2, scale: 1e-6, decimals: 0,
    question: 'Population of Nigeria, 1960–2024 (millions)', yLabel: 'Population (millions)', unit: 'm',
    yMin: 0, yMax: 300, knownFraction: 0.25, difficulty: 2, region: 'africa', source: WB },
  { id: 'irl-pop', src: 'wb', country: 'IRL', indicator: 'SP.POP.TOTL', from: 1960, to: 2024, step: 2, scale: 1e-6, decimals: 2,
    question: 'Population of Ireland, 1960–2024 (millions)', yLabel: 'Population (millions)', unit: 'm',
    yMin: 2, yMax: 7, knownFraction: 0.3, difficulty: 2, region: 'europe', source: WB },
  { id: 'bgr-pop', src: 'wb', country: 'BGR', indicator: 'SP.POP.TOTL', from: 1960, to: 2024, step: 2, scale: 1e-6, decimals: 2,
    question: 'Population of Bulgaria, 1960–2024 (millions)', yLabel: 'Population (millions)', unit: 'm',
    yMin: 5, yMax: 10.5, knownFraction: 0.3, difficulty: 3, region: 'europe', source: WB },
  { id: 'are-pop', src: 'wb', country: 'ARE', indicator: 'SP.POP.TOTL', from: 1960, to: 2024, step: 2, scale: 1e-6, decimals: 2,
    question: 'Population of the United Arab Emirates, 1960–2024 (millions)', yLabel: 'Population (millions)', unit: 'm',
    yMin: 0, yMax: 15, knownFraction: 0.3, difficulty: 2, region: 'asia', source: WB },
  { id: 'jpn-65', src: 'wb', country: 'JPN', indicator: 'SP.POP.65UP.TO.ZS', from: 1960, to: 2024, step: 2, scale: 1, decimals: 1,
    question: 'Share of Japan’s population aged 65 or older, 1960–2024 (%)', yLabel: 'Aged 65+ (%)', unit: '%',
    yMin: 0, yMax: 40, knownFraction: 0.25, difficulty: 2, region: 'asia', source: WB },
  { id: 'chn-urb', src: 'wb', country: 'CHN', indicator: 'SP.URB.TOTL.IN.ZS', from: 1960, to: 2024, step: 2, scale: 1, decimals: 1,
    question: 'Share of China’s population living in cities, 1960–2024 (%)', yLabel: 'Urban population (%)', unit: '%',
    yMin: 0, yMax: 85, knownFraction: 0.3, difficulty: 2, region: 'asia', source: WB },
);

// ── Births, deaths, health ────────────────────────────────────────────────────
S.push(
  { id: 'chn-fert', src: 'wb', country: 'CHN', indicator: 'SP.DYN.TFRT.IN', from: 1960, to: 2024, step: 2, scale: 1, decimals: 2,
    question: 'Fertility rate in China, 1960–2024 (children per woman)', yLabel: 'Children per woman', unit: '',
    yMin: 0, yMax: 10, knownFraction: 0.15, difficulty: 2, region: 'asia', source: WB },
  { id: 'kor-fert', src: 'wb', country: 'KOR', indicator: 'SP.DYN.TFRT.IN', from: 1960, to: 2024, step: 2, scale: 1, decimals: 2,
    question: 'Fertility rate in South Korea, 1960–2024 (children per woman)', yLabel: 'Children per woman', unit: '',
    yMin: 0, yMax: 8, knownFraction: 0.25, difficulty: 2, region: 'asia', source: WB },
  { id: 'wld-fert', src: 'wb', country: 'WLD', indicator: 'SP.DYN.TFRT.IN', from: 1960, to: 2024, step: 2, scale: 1, decimals: 2,
    question: 'Global fertility rate, 1960–2024 (children per woman)', yLabel: 'Children per woman', unit: '',
    yMin: 0, yMax: 7, knownFraction: 0.25, difficulty: 1, source: WB },
  { id: 'irn-fert', src: 'wb', country: 'IRN', indicator: 'SP.DYN.TFRT.IN', from: 1960, to: 2024, step: 2, scale: 1, decimals: 2,
    question: 'Fertility rate in Iran, 1960–2024 (children per woman)', yLabel: 'Children per woman', unit: '',
    yMin: 0, yMax: 10, knownFraction: 0.4, difficulty: 3, region: 'asia', source: WB },
  { id: 'ner-fert', src: 'wb', country: 'NER', indicator: 'SP.DYN.TFRT.IN', from: 1960, to: 2024, step: 2, scale: 1, decimals: 2,
    question: 'Fertility rate in Niger, 1960–2024 (children per woman)', yLabel: 'Children per woman', unit: '',
    yMin: 5, yMax: 8.3, knownFraction: 0.25, difficulty: 3, region: 'africa', source: WB },
  { id: 'wld-le', src: 'wb', country: 'WLD', indicator: 'SP.DYN.LE00.IN', from: 1960, to: 2024, step: 2, scale: 1, decimals: 1,
    question: 'Global life expectancy at birth, 1960–2024 (years)', yLabel: 'Life expectancy (years)', unit: 'yrs',
    yMin: 40, yMax: 85, knownFraction: 0.25, difficulty: 1, source: WB },
  { id: 'rus-le', src: 'wb', country: 'RUS', indicator: 'SP.DYN.LE00.IN', from: 1960, to: 2024, step: 2, scale: 1, decimals: 1,
    question: 'Life expectancy at birth in Russia, 1960–2024 (years)', yLabel: 'Life expectancy (years)', unit: 'yrs',
    yMin: 58, yMax: 78, knownFraction: 0.3, difficulty: 3, region: 'europe', source: WB },
  { id: 'chn-le', src: 'wb', country: 'CHN', indicator: 'SP.DYN.LE00.IN', from: 1960, to: 2024, step: 2, scale: 1, decimals: 1,
    question: 'Life expectancy at birth in China, 1960–2024 (years)', yLabel: 'Life expectancy (years)', unit: 'yrs',
    yMin: 20, yMax: 90, knownFraction: 0.15, difficulty: 2, region: 'asia', source: WB },
  { id: 'kor-le', src: 'wb', country: 'KOR', indicator: 'SP.DYN.LE00.IN', from: 1960, to: 2024, step: 2, scale: 1, decimals: 1,
    question: 'Life expectancy at birth in South Korea, 1960–2024 (years)', yLabel: 'Life expectancy (years)', unit: 'yrs',
    yMin: 40, yMax: 95, knownFraction: 0.25, difficulty: 2, region: 'asia', source: WB },
  { id: 'zwe-le', src: 'wb', country: 'ZWE', indicator: 'SP.DYN.LE00.IN', from: 1960, to: 2024, step: 2, scale: 1, decimals: 1,
    question: 'Life expectancy at birth in Zimbabwe, 1960–2024 (years)', yLabel: 'Life expectancy (years)', unit: 'yrs',
    yMin: 35, yMax: 72, knownFraction: 0.3, difficulty: 3, region: 'africa', source: WB },
  { id: 'ind-u5', src: 'wb', country: 'IND', indicator: 'SH.DYN.MORT', from: 1960, to: 2024, step: 2, scale: 1, decimals: 0,
    question: 'Under-5 child mortality in India, 1960–2024 (deaths per 1,000 live births)', yLabel: 'Deaths per 1,000 births', unit: '',
    yMin: 0, yMax: 320, knownFraction: 0.25, difficulty: 2, region: 'asia', source: WB },
  { id: 'wld-u5', src: 'wb', country: 'WLD', indicator: 'SH.DYN.MORT', from: 1990, to: 2024, step: 1, scale: 1, decimals: 0,
    question: 'Global under-5 child mortality, 1990–2024 (deaths per 1,000 live births)', yLabel: 'Deaths per 1,000 births', unit: '',
    yMin: 0, yMax: 120, knownFraction: 0.25, difficulty: 1, source: WB },
  { id: 'usa-smoking', src: 'manual', decimals: 1,
    // CDC National Health Interview Survey: share of US adults who smoke cigarettes
    series: [[1965, 42.4], [1970, 37.4], [1980, 33.2], [1990, 25.5], [2000, 23.3], [2010, 19.3], [2020, 12.5]],
    question: 'Share of adults in the USA who smoke cigarettes, 1965–2020 (%)', yLabel: 'Adult smokers (%)', unit: '%',
    yMin: 0, yMax: 55, knownFraction: 0.2, difficulty: 2, region: 'north-america', source: 'CDC National Health Interview Survey' },
);

// ── Technology ────────────────────────────────────────────────────────────────
S.push(
  { id: 'usa-net', src: 'wb', country: 'USA', indicator: 'IT.NET.USER.ZS', from: 1990, to: 2024, step: 1, scale: 1, decimals: 1,
    question: 'Share of people in the USA using the internet, 1990–2024 (%)', yLabel: 'Internet users (%)', unit: '%',
    yMin: 0, yMax: 120, knownFraction: 0.25, difficulty: 1, region: 'north-america', source: WB },
  { id: 'chn-net', src: 'wb', country: 'CHN', indicator: 'IT.NET.USER.ZS', from: 1990, to: 2024, step: 1, scale: 1, decimals: 1,
    question: 'Share of people in China using the internet, 1990–2024 (%)', yLabel: 'Internet users (%)', unit: '%',
    yMin: 0, yMax: 120, knownFraction: 0.35, difficulty: 2, region: 'asia', source: WB },
  { id: 'wld-net', src: 'wb', country: 'WLD', indicator: 'IT.NET.USER.ZS', from: 2005, to: 2025, step: 1, scale: 1, decimals: 1,
    question: 'Share of the world population using the internet, 2005–2025 (%)', yLabel: 'Internet users (%)', unit: '%',
    yMin: 0, yMax: 100, knownFraction: 0.25, difficulty: 1, source: WB },
  { id: 'wld-cel', src: 'wb', country: 'WLD', indicator: 'IT.CEL.SETS.P2', from: 1990, to: 2024, step: 1, scale: 1, decimals: 0,
    question: 'Mobile phone subscriptions per 100 people worldwide, 1990–2024', yLabel: 'Subscriptions per 100 people', unit: '',
    yMin: 0, yMax: 150, knownFraction: 0.3, difficulty: 1, source: WB },
  { id: 'hkg-cel', src: 'wb', country: 'HKG', indicator: 'IT.CEL.SETS.P2', from: 1990, to: 2024, step: 1, scale: 1, decimals: 0,
    question: 'Mobile phone subscriptions per 100 people in Hong Kong, 1990–2024', yLabel: 'Subscriptions per 100 people', unit: '',
    yMin: 0, yMax: 480, knownFraction: 0.3, difficulty: 3, region: 'asia', source: WB },
  { id: 'usa-tel', src: 'wb', country: 'USA', indicator: 'IT.MLT.MAIN.P2', from: 1960, to: 2024, step: 2, scale: 1, decimals: 0,
    question: 'Fixed telephone lines per 100 people in the USA, 1960–2024', yLabel: 'Landlines per 100 people', unit: '',
    yMin: 0, yMax: 90, knownFraction: 0.3, difficulty: 2, region: 'north-america', source: WB },
  { id: 'ind-elec', src: 'wb', country: 'IND', indicator: 'EG.ELC.ACCS.ZS', from: 1993, to: 2024, step: 1, scale: 1, decimals: 0,
    question: 'Share of people in India with access to electricity, 1993–2024 (%)', yLabel: 'Electricity access (%)', unit: '%',
    yMin: 30, yMax: 115, knownFraction: 0.25, difficulty: 2, region: 'asia', source: WB },
  { id: 'wld-air', src: 'wb', country: 'WLD', indicator: 'IS.AIR.PSGR', from: 1970, to: 2023, step: 1, scale: 1e-9, decimals: 2,
    question: 'Air passengers carried worldwide per year, 1970–2023 (billions)', yLabel: 'Passengers (billions)', unit: 'bn',
    yMin: 0, yMax: 6, knownFraction: 0.3, difficulty: 1, source: WB },
);

// ── Money ─────────────────────────────────────────────────────────────────────
S.push(
  { id: 'chn-gdppc', src: 'wb', country: 'CHN', indicator: 'NY.GDP.PCAP.CD', from: 1960, to: 2024, step: 2, scale: 1, decimals: 0,
    question: 'GDP per person in China, 1960–2024 (current US$)', yLabel: 'GDP per capita (US$)', unit: '$',
    yMin: 0, yMax: 18000, knownFraction: 0.35, difficulty: 2, region: 'asia', source: WB },
  { id: 'kor-gdppc', src: 'wb', country: 'KOR', indicator: 'NY.GDP.PCAP.CD', from: 1960, to: 2024, step: 2, scale: 1, decimals: 0,
    question: 'GDP per person in South Korea, 1960–2024 (current US$)', yLabel: 'GDP per capita (US$)', unit: '$',
    yMin: 0, yMax: 50000, knownFraction: 0.25, difficulty: 2, region: 'asia', source: WB },
  { id: 'irl-gdppc', src: 'wb', country: 'IRL', indicator: 'NY.GDP.PCAP.CD', from: 1960, to: 2024, step: 2, scale: 1, decimals: 0,
    question: 'GDP per person in Ireland, 1960–2024 (current US$)', yLabel: 'GDP per capita (US$)', unit: '$',
    yMin: 0, yMax: 170000, knownFraction: 0.35, difficulty: 3, region: 'europe', source: WB },
  { id: 'jpn-gdppc', src: 'wb', country: 'JPN', indicator: 'NY.GDP.PCAP.CD', from: 1960, to: 2024, step: 2, scale: 1, decimals: 0,
    question: 'GDP per person in Japan, 1960–2024 (current US$)', yLabel: 'GDP per capita (US$)', unit: '$',
    yMin: 0, yMax: 65000, knownFraction: 0.35, difficulty: 3, region: 'asia', source: WB },
  { id: 'grc-gdppc', src: 'wb', country: 'GRC', indicator: 'NY.GDP.PCAP.CD', from: 1990, to: 2024, step: 1, scale: 1, decimals: 0,
    question: 'GDP per person in Greece, 1990–2024 (current US$)', yLabel: 'GDP per capita (US$)', unit: '$',
    yMin: 0, yMax: 42000, knownFraction: 0.3, difficulty: 3, region: 'europe', source: WB },
  { id: 'usa-cpi', src: 'wb', country: 'USA', indicator: 'FP.CPI.TOTL.ZG', from: 1965, to: 2024, step: 1, scale: 1, decimals: 1,
    question: 'Annual inflation rate in the USA, 1965–2024 (%)', yLabel: 'Inflation (%)', unit: '%',
    yMin: -3, yMax: 17, knownFraction: 0.2, difficulty: 2, region: 'north-america', source: WB },
  { id: 'gbr-cpi', src: 'wb', country: 'GBR', indicator: 'FP.CPI.TOTL.ZG', from: 1965, to: 2024, step: 1, scale: 1, decimals: 1,
    question: 'Annual inflation rate in the United Kingdom, 1965–2024 (%)', yLabel: 'Inflation (%)', unit: '%',
    yMin: -3, yMax: 30, knownFraction: 0.2, difficulty: 2, region: 'europe', source: WB },
  { id: 'jpn-cpi', src: 'wb', country: 'JPN', indicator: 'FP.CPI.TOTL.ZG', from: 1965, to: 2024, step: 1, scale: 1, decimals: 1,
    question: 'Annual inflation rate in Japan, 1965–2024 (%)', yLabel: 'Inflation (%)', unit: '%',
    yMin: -5, yMax: 28, knownFraction: 0.2, difficulty: 3, region: 'asia', source: WB },
  { id: 'esp-unemp', src: 'wb', country: 'ESP', indicator: 'SL.UEM.TOTL.ZS', from: 1991, to: 2024, step: 1, scale: 1, decimals: 1,
    question: 'Unemployment rate in Spain, 1991–2024 (% of the labour force)', yLabel: 'Unemployment (%)', unit: '%',
    yMin: 0, yMax: 35, knownFraction: 0.3, difficulty: 3, region: 'europe', source: WB },
  { id: 'wld-pov', src: 'wb', country: 'WLD', indicator: 'SI.POV.DDAY', from: 1981, to: 2024, step: 1, scale: 1, decimals: 1,
    question: 'Share of the world population living in extreme poverty, 1981–2024 (%)', yLabel: 'Extreme poverty (%)', unit: '%',
    yMin: 0, yMax: 60, knownFraction: 0.25, difficulty: 1, source: WB },
  { id: 'usa-mil', src: 'wb', country: 'USA', indicator: 'MS.MIL.XPND.GD.ZS', from: 1960, to: 2024, step: 2, scale: 1, decimals: 1,
    question: 'Military spending of the USA, 1960–2024 (% of GDP)', yLabel: 'Military spending (% of GDP)', unit: '%',
    yMin: 0, yMax: 12, knownFraction: 0.2, difficulty: 3, region: 'north-america', source: WB },
  { id: 'usa-minwage', src: 'manual', decimals: 2,
    // US federal minimum wage in force at the end of each year (US Dept of Labor)
    series: [[1940, 0.30], [1945, 0.40], [1950, 0.75], [1955, 0.75], [1960, 1.00], [1965, 1.25], [1970, 1.60], [1975, 2.10],
             [1980, 3.10], [1985, 3.35], [1990, 3.80], [1995, 4.25], [2000, 5.15], [2005, 5.15], [2010, 7.25], [2015, 7.25], [2020, 7.25], [2025, 7.25]],
    question: 'US federal minimum wage, 1940–2025 (US$ per hour, not adjusted for inflation)', yLabel: 'Minimum wage (US$/hour)', unit: '$',
    yMin: 0, yMax: 10, knownFraction: 0.3, difficulty: 2, region: 'north-america', source: 'US Department of Labor' },
);

// ── Climate & environment ─────────────────────────────────────────────────────
S.push(
  { id: 'co2-mlo', src: 'noaa', from: 1959, to: 2025, step: 2, decimals: 1,
    question: 'CO₂ in the atmosphere at Mauna Loa, Hawaii, 1959–2025 (parts per million, annual mean)', yLabel: 'CO₂ (ppm)', unit: 'ppm',
    yMin: 280, yMax: 460, knownFraction: 0.25, difficulty: 2, source: 'NOAA Global Monitoring Laboratory' },
  { id: 'gistemp', src: 'gistemp', from: 1880, to: 2025, step: 5, decimals: 2,
    question: 'Global average temperature vs. the 1951–1980 average, 1880–2025 (°C, every 5 years)', yLabel: 'Temperature anomaly (°C)', unit: '°C',
    yMin: -1, yMax: 2, knownFraction: 0.5, difficulty: 1, source: 'NASA GISTEMP v4' },
  { id: 'wld-co2', src: 'wb', country: 'WLD', indicator: 'EN.GHG.CO2.MT.CE.AR5', from: 1970, to: 2024, step: 1, scale: 1e-3, decimals: 1,
    question: 'Global CO₂ emissions per year, 1970–2024 (billion tonnes)', yLabel: 'CO₂ emissions (billion t)', unit: 'bn t',
    yMin: 0, yMax: 52, knownFraction: 0.25, difficulty: 1, source: WB },
  { id: 'gbr-co2', src: 'wb', country: 'GBR', indicator: 'EN.GHG.CO2.PC.CE.AR5', from: 1970, to: 2024, step: 1, scale: 1, decimals: 1,
    question: 'CO₂ emissions per person in the United Kingdom, 1970–2024 (tonnes)', yLabel: 'CO₂ per person (t)', unit: 't',
    yMin: 0, yMax: 16, knownFraction: 0.25, difficulty: 2, region: 'europe', source: WB },
  { id: 'chn-co2', src: 'wb', country: 'CHN', indicator: 'EN.GHG.CO2.PC.CE.AR5', from: 1970, to: 2024, step: 1, scale: 1, decimals: 1,
    question: 'CO₂ emissions per person in China, 1970–2024 (tonnes)', yLabel: 'CO₂ per person (t)', unit: 't',
    yMin: 0, yMax: 12, knownFraction: 0.3, difficulty: 2, region: 'asia', source: WB },
  { id: 'usa-co2', src: 'wb', country: 'USA', indicator: 'EN.GHG.CO2.PC.CE.AR5', from: 1970, to: 2024, step: 1, scale: 1, decimals: 1,
    question: 'CO₂ emissions per person in the USA, 1970–2024 (tonnes)', yLabel: 'CO₂ per person (t)', unit: 't',
    yMin: 10, yMax: 26, knownFraction: 0.25, difficulty: 2, region: 'north-america', source: WB },
  { id: 'chn-forest', src: 'wb', country: 'CHN', indicator: 'AG.LND.FRST.ZS', from: 1990, to: 2023, step: 1, scale: 1, decimals: 1,
    question: 'Share of China’s land covered by forest, 1990–2023 (%)', yLabel: 'Forest area (%)', unit: '%',
    yMin: 12, yMax: 28, knownFraction: 0.25, difficulty: 3, region: 'asia', source: WB },
);

// ── Sport, politics & cities (hand-curated) ───────────────────────────────────
S.push(
  { id: 'wr-100m', src: 'manual', decimals: 2,
    // World Athletics record progression; value = record standing at the end of each Olympic year
    series: [[1912, 10.6], [1916, 10.6], [1920, 10.6], [1924, 10.4], [1928, 10.4], [1932, 10.3], [1936, 10.2], [1940, 10.2], [1944, 10.2],
             [1948, 10.2], [1952, 10.2], [1956, 10.1], [1960, 10.0], [1964, 10.0], [1968, 9.95], [1972, 9.95], [1976, 9.95], [1980, 9.95],
             [1984, 9.93], [1988, 9.92], [1992, 9.86], [1996, 9.84], [2000, 9.79], [2004, 9.79], [2008, 9.69], [2012, 9.58], [2016, 9.58],
             [2020, 9.58], [2024, 9.58]],
    question: 'Men’s 100 m world record at the end of each Olympic year, 1912–2024 (seconds)', yLabel: 'World record (s)', unit: 's',
    yMin: 9, yMax: 11, knownFraction: 0.3, difficulty: 2, source: 'World Athletics record progression' },
  { id: 'un-members', src: 'manual', decimals: 0,
    series: [[1945, 51], [1950, 60], [1955, 76], [1960, 99], [1965, 117], [1970, 127], [1975, 144], [1980, 154], [1985, 159],
             [1990, 159], [1995, 185], [2000, 189], [2005, 191], [2010, 192], [2015, 193], [2020, 193], [2025, 193]],
    question: 'Number of United Nations member states, 1945–2025', yLabel: 'Member states', unit: '',
    yMin: 0, yMax: 250, knownFraction: 0.2, difficulty: 2, source: 'United Nations' },
  { id: 'olympic-nations', src: 'manual', decimals: 0,
    series: [[1896, 14], [1900, 24], [1904, 12], [1908, 22], [1912, 28], [1920, 29], [1924, 44], [1928, 46], [1932, 37], [1936, 49],
             [1948, 59], [1952, 69], [1956, 72], [1960, 83], [1964, 93], [1968, 112], [1972, 121], [1976, 92], [1980, 80], [1984, 140],
             [1988, 159], [1992, 169], [1996, 197], [2000, 199], [2004, 201], [2008, 204], [2012, 204], [2016, 207], [2020, 206], [2024, 206]],
    question: 'Number of nations competing at each Summer Olympics, 1896–2024', yLabel: 'Nations competing', unit: '',
    yMin: 0, yMax: 270, knownFraction: 0.3, difficulty: 2, source: 'International Olympic Committee' },
  { id: 'detroit-pop', src: 'manual', decimals: 2,
    // US Census counts for the city of Detroit
    series: [[1900, 0.29], [1910, 0.47], [1920, 0.99], [1930, 1.57], [1940, 1.62], [1950, 1.85], [1960, 1.67], [1970, 1.51],
             [1980, 1.20], [1990, 1.03], [2000, 0.95], [2010, 0.71], [2020, 0.64]],
    question: 'Population of the city of Detroit at each US census, 1900–2020 (millions)', yLabel: 'Population (millions)', unit: 'm',
    yMin: 0, yMax: 2.4, knownFraction: 0.35, difficulty: 2, region: 'north-america', source: 'US Census Bureau' },
  { id: 'london-pop', src: 'manual', decimals: 1,
    // UK census counts for Greater London (no census was held in 1941)
    series: [[1901, 6.5], [1911, 7.2], [1921, 7.4], [1931, 8.1], [1951, 8.2], [1961, 8.0], [1971, 7.5], [1981, 6.8],
             [1991, 6.8], [2001, 7.2], [2011, 8.2], [2021, 8.8]],
    question: 'Population of Greater London at each census, 1901–2021 (millions)', yLabel: 'Population (millions)', unit: 'm',
    yMin: 5, yMax: 10, knownFraction: 0.3, difficulty: 3, region: 'europe', source: 'UK Office for National Statistics' },
);

// ═════════════════════════════════════════════════════════════════════════════
// 2. FETCHING (with a file cache under tools/raw/curves/)
// ═════════════════════════════════════════════════════════════════════════════
fs.mkdirSync(RAW_DIR, { recursive: true });

async function cachedText(key, url) {
  const file = path.join(RAW_DIR, key);
  if (fs.existsSync(file)) return fs.readFileSync(file, 'utf8');
  if (OFFLINE) throw new Error(`offline and ${key} is not cached`);
  process.stderr.write(`↓ ${url} … `);
  // A couple of retries: these public servers occasionally drop a connection.
  let lastErr;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const r = await fetch(url);
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const text = await r.text();
      fs.writeFileSync(file, text);
      process.stderr.write('done\n');
      return text;
    } catch (e) { lastErr = e; await new Promise(res => setTimeout(res, 1500 * attempt)); }
  }
  process.stderr.write('FAILED\n');
  throw lastErr;
}

// World Bank → [[year, value], …] ascending, nulls dropped
async function fetchWorldBank(country, indicator) {
  const text = await cachedText(`wb-${country}-${indicator}.json`,
    `https://api.worldbank.org/v2/country/${country}/indicator/${indicator}?format=json&per_page=100`);
  const json = JSON.parse(text);
  if (!Array.isArray(json) || !Array.isArray(json[1])) throw new Error(`World Bank returned no rows for ${country}/${indicator}: ${text.slice(0, 120)}`);
  return json[1].filter(r => r.value !== null).map(r => [parseInt(r.date, 10), r.value]).sort((a, b) => a[0] - b[0]);
}

// NOAA Mauna Loa annual mean CO2 → [[year, ppm], …]
async function fetchNoaa() {
  const text = await cachedText('noaa-co2-annmean-mlo.csv', 'https://gml.noaa.gov/webdata/ccgg/trends/co2/co2_annmean_mlo.csv');
  return text.split('\n').filter(l => /^\d{4},/.test(l)).map(l => { const c = l.split(','); return [parseInt(c[0], 10), parseFloat(c[1])]; });
}

// NASA GISTEMP global land-ocean anomaly, annual (J-D column) → [[year, °C], …]
async function fetchGistemp() {
  const text = await cachedText('gistemp-GLB.Ts+dSST.csv', 'https://data.giss.nasa.gov/gistemp/tabledata_v4/GLB.Ts+dSST.csv');
  const lines = text.split('\n');
  const header = lines.findIndex(l => l.startsWith('Year,'));
  const cols = lines[header].split(',');
  const jd = cols.indexOf('J-D');
  const out = [];
  for (const l of lines.slice(header + 1)) {
    const c = l.split(',');
    if (!/^\d{4}$/.test(c[0]) || c[jd] === '***' || c[jd] === undefined || c[jd] === '') continue;
    out.push([parseInt(c[0], 10), parseFloat(c[jd])]);
  }
  return out;
}

// ═════════════════════════════════════════════════════════════════════════════
// 3. SHAPING: thin a full-resolution series to the years we want
// ═════════════════════════════════════════════════════════════════════════════
const round = (v, d) => Math.round(v * 10 ** d) / 10 ** d;

function thin(full, { from, to, step, scale = 1, decimals = 2 }, label) {
  const byYear = new Map(full.map(([x, y]) => [x, y]));
  if (!byYear.has(to)) throw new Error(`${label}: no data for the last year ${to} (latest is ${full[full.length - 1][0]})`);
  const out = [];
  for (let x = from; x <= to; x += step) {
    if (!byYear.has(x)) { console.warn(`  ! ${label}: no value for ${x}, skipped`); continue; }
    out.push([x, round(byYear.get(x) * scale, decimals)]);
  }
  if (out[out.length - 1][0] !== to) out.push([to, round(byYear.get(to) * scale, decimals)]);   // always end on `to`
  return out;
}

// ═════════════════════════════════════════════════════════════════════════════
// 4. MAIN
// ═════════════════════════════════════════════════════════════════════════════
(async () => {
  const src = {};        // id → full-resolution fetched series (for data/curves-src.json)
  const questions = [];
  const ids = new Set();

  for (const spec of S) {
    if (ids.has(spec.id)) throw new Error(`duplicate id ${spec.id}`);
    ids.add(spec.id);

    let series;
    if (spec.src === 'wb') {
      const full = await fetchWorldBank(spec.country, spec.indicator);
      src[spec.id] = { source: 'worldbank', country: spec.country, indicator: spec.indicator, points: full };
      series = thin(full, spec, spec.id);
    } else if (spec.src === 'noaa') {
      const full = await fetchNoaa();
      src[spec.id] = { source: 'noaa-mlo', points: full };
      series = thin(full, spec, spec.id);
    } else if (spec.src === 'gistemp') {
      const full = await fetchGistemp();
      src[spec.id] = { source: 'gistemp', points: full };
      series = thin(full, spec, spec.id);
    } else if (spec.src === 'manual') {
      series = spec.series.map(([x, y]) => [x, round(y, spec.decimals)]);
      if (spec.appendWb) {      // a hand-typed prefix continued with World Bank data
        const full = await fetchWorldBank(spec.appendWb.country, spec.appendWb.indicator);
        src[spec.id] = { source: 'manual+worldbank', ...spec.appendWb, points: full };
        series = series.concat(thin(full, { ...spec.appendWb, decimals: spec.decimals }, spec.id));
      }
    } else throw new Error(`${spec.id}: unknown src ${spec.src}`);

    const q = {
      type: 'curve', category: 'curves',
      question: spec.question,
      series,
      xLabel: 'Year', yLabel: spec.yLabel, unit: spec.unit, yMin: spec.yMin, yMax: spec.yMax,
      knownFraction: spec.knownFraction, decimals: spec.decimals, source: spec.source,
      difficulty: spec.difficulty,
    };
    if (spec.region) q.region = spec.region;

    // Validate with the real game module — same rules as import.js
    const errors = curveModule.validate(q);
    if (errors.length) throw new Error(`${spec.id}: ${errors.join('; ')}`);

    // Report how much of the axis the truth uses (aim: 40–80 %)
    const ys = series.map(p => p[1]);
    const usage = (Math.max(...ys) - Math.min(...ys)) / (q.yMax - q.yMin);
    const flag = usage < 0.4 || usage > 0.8 ? '  <-- axis usage outside 40–80 %' : '';
    const known = curveModule.payload(q).known.length;
    console.log(`${spec.id.padEnd(16)} ${String(series.length).padStart(2)} pts  known ${known}  ${series[0][0]}–${series[series.length - 1][0]}  axis ${(usage * 100).toFixed(0)} %${flag}`);
    questions.push(q);
  }

  fs.mkdirSync(path.dirname(OUT_SRC), { recursive: true });
  fs.mkdirSync(path.dirname(OUT_QS), { recursive: true });
  fs.writeFileSync(OUT_SRC, JSON.stringify(src));
  fs.writeFileSync(OUT_QS, JSON.stringify(questions, null, 1));

  const byDiff = [1, 2, 3].map(d => `${d}: ${questions.filter(q => q.difficulty === d).length}`).join('  ');
  console.log(`\n✓ ${questions.length} questions → ${path.relative(ROOT, OUT_QS)}   (difficulty ${byDiff})`);
  console.log(`✓ ${Object.keys(src).length} cached series → ${path.relative(ROOT, OUT_SRC)} (${(fs.statSync(OUT_SRC).size / 1024).toFixed(0)} KB)`);
})().catch(e => { console.error('✗', e.message); process.exit(1); });
