import assert from 'node:assert/strict';
import test from 'node:test';

import {
  Evidence, judgeDirection, newsRelevance,
} from '../lib/js/sentiment-data.js';
import {
  render, renderBrief, summarize,
} from '../lib/js/sentiment.js';
import { runSentiment } from '../lib/js/sentiment-tool.js';

function ev(over = {}) {
  return new Evidence({
    category: 'announce',
    title: '公告',
    reliability: 'hard_fact',
    direction: 'unknown',
    as_of: '2026-11-06',
    source: '东方财富·公告',
    ...over,
  });
}

test('舆情方向判定：正负词 / 同时出现 / 无词', () => {
  assert.equal(judgeDirection('公司拟增持并回购'), 'positive');
  assert.equal(judgeDirection('股东减持，遭立案调查'), 'negative');
  assert.equal(judgeDirection('增持但被处罚'), 'neutral');
  assert.equal(judgeDirection('日常经营公告'), 'unknown');
});

test('新闻相关度：direct / industry / weak', () => {
  assert.equal(newsRelevance('浦发银行发布公告', '', '浦发银行', '600000'), 'direct');
  assert.equal(newsRelevance('银行行业周报：多家银行下调利率', '', '浦发银行', '600000'), 'industry');
  assert.equal(newsRelevance('18只ETF开售', '浦发银行参股', '浦发银行', '600000'), 'industry');
  assert.equal(newsRelevance('某公司发布新品', '', '浦发银行', '600000'), 'weak');
});

test('舆情归集：研报 vs 两融背离 / 过期证据 / tone', () => {
  const items = [
    ev({ category: 'report', title: '买入评级', reliability: 'official_view', direction: 'positive' }),
    ev({
      category: 'margin', title: '融资余额下降', direction: 'negative',
      meta: { delta_pct: -4.17 },
    }),
    ev({ category: 'news', title: '旧闻', as_of: '2026-01-01', direction: 'positive' }),
    ev({ category: 'announce', title: '回购公告', direction: 'positive' }),
  ];
  const extras = { margin: { trend: { delta_pct: -4.17, window: '2026-11-02 → 2026-11-06' } } };
  const report = summarize(items, '600000', '浦发银行', {}, extras);
  assert.equal(report.tone, 'conflicted');
  assert.equal(report.conflicts[0].kind, 'report_vs_margin');
  assert.equal(report.conflicts[0].severity, 'high');
  assert.equal(report.stale_items.length, 1);
  assert.equal(report.categories.some((c) => c.category === 'news'), false);

  const md = render(report, items, extras);
  assert.match(md, /^## 舆情分析：浦发银行（600000）/);
  assert.match(md, /信号背离（优先看这里）/);
  assert.match(md, /研报偏多，但融资余额在下降/);
  assert.match(md, /超过 30 天的旧闻 1 条/);
  assert.match(md, /不预测涨跌、不给评级/);

  const brief = renderBrief(report);
  assert.match(brief, /浦发银行：🟡 证据背离/);
});

test('舆情归集：证据不足', () => {
  const report = summarize([ev()], '600000', '浦发银行');
  assert.equal(report.tone, 'thin');
  assert.match(report.tone_text, /有效证据仅 0 条/);
  assert.match(renderBrief(report), /证据不足/);
});

test('astock_sentiment：注入证据渲染 / brief 数据缺口', async () => {
  const collected = {
    code: '600000',
    name: '浦发银行',
    items: [
      ev({ category: 'announce', title: '回购公告', direction: 'positive' }),
      ev({ category: 'margin', title: '融资余额下降', direction: 'negative' }),
    ],
    extras: {},
    errors: { news: '无直接相关新闻' },
  };
  const out = await runSentiment({ code: '600000' }, {
    fetchQuotes: async () => [{ code: '600000', name: '浦发银行' }],
    collect: async () => collected,
  });
  assert.match(out, /^## 舆情分析：浦发银行（600000）/);
  assert.match(out, /数据质量说明/);
  assert.match(out, /无直接相关新闻/);

  const brief = await runSentiment({ code: '600000', brief: true }, {
    fetchQuotes: async () => [{ code: '600000', name: '浦发银行' }],
    collect: async () => collected,
  });
  assert.match(brief, /数据缺口：news=无直接相关新闻/);
});
