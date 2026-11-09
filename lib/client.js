window.__ModuleLoader__.load({
	// 这里必须是 **npm 包名**（含 scope）：DSH 的 client-modules 用 package.json
	// 的 name 作为模块 id 去 `factories` 里找。写成 "dsh-astock" 会让宿主找不到、
	// 回退到单包 URL 再执行一次，第二次注册就报 duplicate factory registration，
	// web boot 随即判定该 entry 激活失败。
	id: "@laynepeng/dsh-astock",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		const react = require("react");
		const { jsx, jsxs } = require("react/jsx-runtime");

		//#region 常量
		/** 数据端点（宿主 lib/plugin.js 用同一个路径注册）。 */
		const PANEL_URL = "/api/dsh-astock/panel";
		/** 本实现在 tab 系统里的身份，同时也是 body 注册用的 key。 */
		const ID = "dsh-astock";
		/** 页面类型的 kind（一个 kind 最多一个 extension 在生效）。 */
		const KIND = "astock";
		/** 选股会真扫全市场（数秒），所以只能在用户点「刷新」时触发。 */
		const VIEWS = [
			{ key: "portfolio", label: "持仓" },
			{ key: "pick", label: "选股" },
			{ key: "maint", label: "维护" },
			{ key: "settings", label: "配置" }
		];
		//#endregion

		//#region 样式
		/**
		 * 样式用一张 <style> 注入，类名带 `dsa-` 前缀。
		 *
		 * 颜色全部走宿主的设计变量（--dsw-alias-*），不自带配色：右栏是页面的一列，
		 * 跟着主题走才不会在深色模式下变成一块亮斑。
		 */
		const CSS = `
.dsa-root{display:flex;flex-direction:column;height:100%;min-height:0;font-size:13px;color:var(--dsw-alias-label-primary);}
.dsa-head{display:flex;align-items:center;gap:4px;padding:8px 10px;border-bottom:1px solid var(--dsw-alias-border-l1);flex:none;flex-wrap:wrap;}
.dsa-tab{border:none;background:transparent;color:var(--dsw-alias-label-secondary);font:inherit;font-size:12px;padding:3px 7px;border-radius:6px;cursor:pointer;white-space:nowrap;}
.dsa-tab[data-active="true"]{background:var(--dsw-alias-button-secondary-fill, rgba(127,127,127,.16));color:var(--dsw-alias-label-primary);font-weight:600;}
.dsa-spacer{flex:1;}
.dsa-icon{border:none;background:transparent;color:var(--dsw-alias-label-secondary);cursor:pointer;font:inherit;font-size:12px;padding:3px 7px;border-radius:6px;}
.dsa-icon:hover:not(:disabled){background:var(--dsw-alias-button-secondary-fill, rgba(127,127,127,.16));}
.dsa-icon:disabled{opacity:.45;cursor:default;}
.dsa-body{flex:1;min-height:0;overflow:auto;padding:10px;}
.dsa-kpis{display:grid;grid-template-columns:1fr 1fr;gap:6px;margin-bottom:10px;}
.dsa-kpi{border:1px solid var(--dsw-alias-border-l1);border-radius:8px;padding:7px 9px;}
.dsa-kpi-label{font-size:11px;color:var(--dsw-alias-label-secondary);}
.dsa-kpi-value{font-size:15px;font-weight:600;margin-top:2px;font-variant-numeric:tabular-nums;}
.dsa-kpi-sub{font-size:11px;color:var(--dsw-alias-label-secondary);margin-top:2px;}
.dsa-up{color:#d64545;}
.dsa-down{color:#0a9e6a;}
.dsa-card{border:1px solid var(--dsw-alias-border-l1);border-radius:8px;padding:9px 10px;margin-bottom:8px;}
.dsa-card[data-risk="true"]{border-color:#d64545aa;}
.dsa-row{display:flex;align-items:baseline;gap:6px;}
.dsa-name{font-weight:600;}
.dsa-code{font-size:11px;color:var(--dsw-alias-label-secondary);font-variant-numeric:tabular-nums;}
.dsa-badge{font-size:10px;padding:1px 6px;border-radius:999px;border:1px solid var(--dsw-alias-border-l1);color:var(--dsw-alias-label-secondary);white-space:nowrap;}
.dsa-badge[data-level="urgent"]{border-color:#d64545;color:#d64545;}
.dsa-badge[data-level="action"]{border-color:#e08a00;color:#e08a00;}
.dsa-grid{display:grid;grid-template-columns:1fr 1fr;gap:2px 10px;margin-top:6px;}
.dsa-cell{display:flex;justify-content:space-between;gap:8px;font-size:12px;font-variant-numeric:tabular-nums;}
.dsa-cell span:first-child{color:var(--dsw-alias-label-secondary);}
.dsa-bar{position:relative;height:4px;border-radius:2px;background:var(--dsw-alias-border-l1);margin-top:7px;overflow:hidden;}
.dsa-bar-fill{position:absolute;inset:0 auto 0 0;border-radius:2px;}
.dsa-section{font-size:11px;font-weight:600;color:var(--dsw-alias-label-secondary);margin:12px 0 6px;letter-spacing:.02em;}
.dsa-list{display:flex;flex-direction:column;gap:3px;}
.dsa-line{display:flex;justify-content:space-between;gap:8px;font-size:12px;padding:2px 0;font-variant-numeric:tabular-nums;}
.dsa-note{font-size:11px;color:var(--dsw-alias-label-secondary);line-height:1.55;margin-top:8px;}
.dsa-error{margin:10px;padding:9px 10px;border-radius:8px;border:1px solid #d64545aa;font-size:12px;line-height:1.6;}
.dsa-empty{padding:16px 6px;text-align:center;font-size:12px;color:var(--dsw-alias-label-secondary);line-height:1.7;}
.dsa-strategy{border:1px solid var(--dsw-alias-border-l1);border-radius:8px;padding:9px 10px;margin-bottom:8px;}
.dsa-strategy[data-default="true"]{border-color:var(--dsw-alias-label-secondary);}
.dsa-strategy-desc{font-size:11px;color:var(--dsw-alias-label-secondary);line-height:1.5;margin-top:3px;}
.dsa-pick{display:flex;justify-content:space-between;gap:8px;font-size:12px;padding:4px 0;border-top:1px dashed var(--dsw-alias-border-l1);font-variant-numeric:tabular-nums;}
.dsa-pick:first-of-type{border-top:none;}
.dsa-ask{border:1px solid var(--dsw-alias-border-l1);background:transparent;color:var(--dsw-alias-label-secondary);font:inherit;font-size:11px;padding:1px 6px;border-radius:999px;cursor:pointer;white-space:nowrap;}
.dsa-ask:hover{background:var(--dsw-alias-button-secondary-fill, rgba(127,127,127,.16));color:var(--dsw-alias-label-primary);}
.dsa-btn{border:1px solid var(--dsw-alias-border-l1);background:transparent;color:var(--dsw-alias-label-primary);font:inherit;font-size:12px;padding:4px 9px;border-radius:7px;cursor:pointer;text-decoration:none;display:inline-block;line-height:1.5;}
.dsa-btn:hover:not(:disabled){background:var(--dsw-alias-button-secondary-fill, rgba(127,127,127,.16));}
.dsa-btn:disabled{opacity:.45;cursor:default;}
.dsa-actions{display:flex;gap:6px;flex-wrap:wrap;margin-top:8px;align-items:center;}
.dsa-spark{width:100%;height:28px;display:block;margin-top:8px;}
.dsa-spark-label{font-size:10px;color:var(--dsw-alias-label-secondary);margin-top:2px;}
.dsa-textarea{width:100%;box-sizing:border-box;min-height:76px;resize:vertical;font:inherit;font-size:12px;padding:6px 8px;border-radius:7px;border:1px solid var(--dsw-alias-border-l1);background:transparent;color:var(--dsw-alias-label-primary);}
.dsa-input,.dsa-select{width:100%;box-sizing:border-box;font:inherit;font-size:12px;padding:5px 8px;border-radius:7px;border:1px solid var(--dsw-alias-border-l1);background:transparent;color:var(--dsw-alias-label-primary);}
.dsa-select option{color:#202124;background:#ffffff;}
.dsa-seg{display:flex;flex-wrap:wrap;gap:4px;}
.dsa-seg-btn{flex:1 1 auto;min-width:0;border:1px solid var(--dsw-alias-border-l1);background:transparent;color:var(--dsw-alias-label-secondary);font:inherit;font-size:11px;line-height:1.5;padding:4px 8px;border-radius:7px;cursor:pointer;text-align:left;}
.dsa-seg-btn:hover{background:var(--dsw-alias-button-secondary-fill, rgba(127,127,127,.16));color:var(--dsw-alias-label-primary);}
.dsa-seg-btn[data-active="true"]{border-color:var(--dsw-alias-label-primary);color:var(--dsw-alias-label-primary);font-weight:600;}
.dsa-wiz-steps{display:flex;align-items:center;gap:6px;font-size:11px;color:var(--dsw-alias-label-secondary);margin:2px 0 8px;}
.dsa-wiz-cards{display:grid;grid-template-columns:1fr 1fr;gap:6px;}
.dsa-wiz-card{border:1px solid var(--dsw-alias-border-l1);background:transparent;color:var(--dsw-alias-label-primary);font:inherit;text-align:left;padding:8px;border-radius:8px;cursor:pointer;}
.dsa-wiz-card:hover{background:var(--dsw-alias-button-secondary-fill, rgba(127,127,127,.16));}
.dsa-wiz-card[data-active="true"]{border-color:var(--dsw-alias-label-primary);}
.dsa-wiz-card-title{font-size:12px;font-weight:600;}
.dsa-wiz-card-hint{font-size:10px;color:var(--dsw-alias-label-secondary);line-height:1.5;margin-top:2px;}
.dsa-group{border-top:1px dashed var(--dsw-alias-border-l1);padding:2px 0 6px;}
.dsa-group-head{border:none;background:transparent;color:var(--dsw-alias-label-secondary);font:inherit;font-size:11px;font-weight:600;padding:6px 0 4px;cursor:pointer;text-align:left;width:100%;}
.dsa-group-head:hover{color:var(--dsw-alias-label-primary);}
.dsa-field{margin-bottom:9px;}
.dsa-field-label{display:block;font-size:11px;color:var(--dsw-alias-label-secondary);margin-bottom:2px;}
.dsa-field-hint{font-size:10px;color:var(--dsw-alias-label-secondary);margin-top:2px;line-height:1.5;}
.dsa-code-big{font-family:ui-monospace,Consolas,monospace;font-size:20px;letter-spacing:2px;font-weight:600;margin:6px 0;}
.dsa-banner{margin:8px 0;padding:8px 10px;border-radius:8px;border:1px solid var(--dsw-alias-border-l1);font-size:12px;line-height:1.55;white-space:pre-wrap;}
.dsa-banner[data-ok="true"]{border-color:#0a9e6a88;}
.dsa-banner[data-ok="false"]{border-color:#d64545aa;}
.dsa-preview{max-height:220px;overflow:auto;margin-top:6px;}
.dsa-preview-row{display:grid;grid-template-columns:1fr auto;gap:2px 8px;font-size:11px;padding:4px 0;border-top:1px dashed var(--dsw-alias-border-l1);font-variant-numeric:tabular-nums;}
.dsa-preview-row[data-status="error"]{color:#d64545;}
.dsa-preview-row[data-status="duplicate"]{color:var(--dsw-alias-label-secondary);}
.dsa-mono{font-family:ui-monospace,Consolas,monospace;font-size:11px;}
`;

		/** 只注入一次（插件重载后宿主文档还在，重复注入会堆样式表）。 */
		function ensureCss() {
			const tagId = "dsh-astock/panel.css";
			if (typeof document === "undefined") return;
			if (document.querySelector("style[data-plugin-css=" + JSON.stringify(tagId) + "]") !== null) return;
			const tag = document.createElement("style");
			tag.dataset.plugin = "dsh-astock";
			tag.dataset.pluginCss = tagId;
			tag.textContent = CSS;
			document.head.appendChild(tag);
		}
		//#endregion

		//#region 数字格式化
		function fmtMoney(value, digits = 2) {
			if (value === null || value === undefined || Number.isNaN(Number(value))) return "—";
			return Number(value).toLocaleString("zh-CN", {
				minimumFractionDigits: digits,
				maximumFractionDigits: digits
			});
		}
		function fmtSigned(value, digits = 2, suffix = "") {
			if (value === null || value === undefined || Number.isNaN(Number(value))) return "—";
			const n = Number(value);
			const sign = n > 0 ? "+" : "";
			return sign + n.toFixed(digits) + suffix;
		}
		function fmtPct(value) {
			if (value === null || value === undefined || Number.isNaN(Number(value))) return "—";
			return fmtSigned(value, 2, "%");
		}
		/** 涨跌配色：A 股习惯红涨绿跌（与上游面板一致，不要改成国际配色）。 */
		function trendClass(value) {
			if (value === null || value === undefined || Number.isNaN(Number(value))) return "";
			return Number(value) > 0 ? "dsa-up" : Number(value) < 0 ? "dsa-down" : "";
		}

		/** 时间戳转本地可读时间（状态文件里存的是 ISO/UTC）。 */
		function fmtDateTime(value) {
			if (!value) return "—";
			const when = new Date(value);
			if (Number.isNaN(when.getTime())) return String(value);
			return when.toLocaleString("zh-CN", { hour12: false });
		}
		//#endregion

		//#region 追问：把问题写进输入框
		/**
		 * 把一句话写进当前会话的输入框（**不自动发送**）。
		 *
		 * `inputActions` 是右栏 tab 的标准 prop（由 ui-conversation 提供）：
		 *   · `captureInsertion()` + `insertText(text, span)` 在光标处插入，保留
		 *     用户已经写了一半的草稿；
		 *   · 编辑器未挂载/只读时退到 `setDraft(text)`（替换草稿）。
		 * 面板只负责「把问题准备好」，发不发由用户按回车决定——自动发送会消耗
		 * token，也容易把用户没想好的问题发出去。
		 */
		function askWith(inputActions, text) {
			if (!inputActions || !text) return false;
			try {
				const span = typeof inputActions.captureInsertion === "function"
					? inputActions.captureInsertion()
					: null;
				if (span && typeof inputActions.insertText === "function"
					&& inputActions.insertText(text, span)) {
					return true;
				}
			} catch (error) {
				/* 编辑器没挂载：继续走 setDraft */
			}
			try {
				if (typeof inputActions.setDraft === "function") {
					inputActions.setDraft(text);
					return true;
				}
			} catch (error) {
				/* 会话不可编辑：什么也不做，按钮只是没反应 */
			}
			return false;
		}

		/** 小圆角按钮：点了把问题写进输入框。 */
		function AskButton({ onAsk, label, title }) {
			return jsx("button", {
				className: "dsa-ask",
				title: title || "写入输入框（不自动发送）",
				onClick: (event) => {
					if (event && typeof event.stopPropagation === "function") event.stopPropagation();
					onAsk();
				},
				children: label
			});
		}

		/** 收盘净值迷你图（只有两个以上记录点才画）。 */
		function Sparkline({ points }) {
			const values = (points || [])
				.map((point) => Number(point && point.equity))
				.filter((value) => Number.isFinite(value));
			if (values.length < 2) return null;
			const width = 100;
			const height = 26;
			const min = Math.min(...values);
			const max = Math.max(...values);
			const span = max - min || 1;
			const coords = values.map((value, index) => {
				const x = (index / (values.length - 1)) * width;
				const y = height - 1 - ((value - min) / span) * (height - 2);
				return x.toFixed(2) + "," + y.toFixed(2);
			});
			const rising = values[values.length - 1] >= values[0];
			const first = points[0] && points[0].date ? points[0].date : "";
			const last = points[points.length - 1] && points[points.length - 1].date
				? points[points.length - 1].date
				: "";
			return jsxs("div", {
				children: [
					jsx("svg", {
						className: "dsa-spark",
						viewBox: "0 0 " + width + " " + height,
						preserveAspectRatio: "none",
						children: jsx("polyline", {
							points: coords.join(" "),
							fill: "none",
							stroke: rising ? "#d64545" : "#0a9e6a",
							strokeWidth: 1.6,
							vectorEffect: "non-scaling-stroke"
						})
					}),
					jsx("div", {
						className: "dsa-spark-label",
						children: "收盘净值 " + first + " → " + last
					})
				]
			});
		}
		//#endregion

		//#region 组件：KPI
		function KpiCard({ item }) {
			const delta = item.delta === null || item.delta === undefined
				? null
				: (item.deltaLabel === "对成本" ? fmtPct(item.delta) : fmtSigned(item.delta, 2));
			return jsxs("div", {
				className: "dsa-kpi",
				children: [
					jsx("div", { className: "dsa-kpi-label", children: item.label }),
					jsx("div", {
						className: "dsa-kpi-value " + (item.trend ? trendClass(item.value) : ""),
						children: fmtMoney(item.value)
							+ (item.unit && item.value !== null && item.value !== undefined ? " " + item.unit : "")
					}),
					delta === null
						? (item.note ? jsx("div", { className: "dsa-kpi-sub", children: item.note }) : null)
						: jsxs("div", {
							className: "dsa-kpi-sub " + trendClass(item.delta),
							children: [(item.deltaLabel || "") + " ", delta]
						})
				]
			});
		}
		//#endregion

		//#region 组件：持仓卡片
		function PositionCard({ item, onAsk }) {
			const risky = item.overWeight || (item.badges && item.badges.length > 0);
			const used = Math.max(0, Math.min(100, Number(item.stopUsedPct) || 0));
			return jsxs("div", {
				className: "dsa-card",
				"data-risk": risky ? "true" : "false",
				children: [
					jsxs("div", {
						className: "dsa-row",
						children: [
							jsx("span", { className: "dsa-name", children: item.name }),
							jsx("span", { className: "dsa-code", children: item.code }),
							jsx("span", { className: "dsa-spacer" }),
							jsx("span", {
								className: "dsa-code " + trendClass(item.changePct),
								children: fmtPct(item.changePct)
							}),
							onAsk
								? jsx(AskButton, {
									label: "分析",
									onAsk: () => onAsk("分析一下 " + item.name + "（" + item.code + "）的持仓："
										+ "现价、成本、止损止盈距离、资金流与舆情，有没有该处理的？")
								})
								: null
						]
					}),
					jsxs("div", {
						className: "dsa-grid",
						children: [
							jsxs("div", {
								className: "dsa-cell",
								children: [
									jsx("span", { children: "现价" }),
									jsx("span", { children: fmtMoney(item.price, 3) })
								]
							}),
							jsxs("div", {
								className: "dsa-cell",
								children: [
									jsx("span", { children: "成本" }),
									jsx("span", { children: fmtMoney(item.cost, 3) })
								]
							}),
							jsxs("div", {
								className: "dsa-cell",
								children: [
									jsx("span", { children: "浮盈" }),
									jsx("span", {
										className: trendClass(item.pnl),
										children: fmtSigned(item.pnl)
									})
								]
							}),
							jsxs("div", {
								className: "dsa-cell",
								children: [
									jsx("span", { children: "盈亏%" }),
									jsx("span", {
										className: trendClass(item.pnlPct),
										children: fmtPct(item.pnlPct)
									})
								]
							}),
							jsxs("div", {
								className: "dsa-cell",
								children: [
									jsx("span", { children: "市值" }),
									jsx("span", { children: fmtMoney(item.marketValue) })
								]
							}),
							jsxs("div", {
								className: "dsa-cell",
								children: [
									jsx("span", { children: "占比" }),
									jsx("span", {
										className: item.overWeight ? "dsa-up" : "",
										children: (item.weightPct === null ? "—" : item.weightPct + "%")
											+ " / " + item.weightCapPct + "%"
									})
								]
							})
						]
					}),
					// 距止损条：只在有浮亏时才有意义（浮盈时 used=0，不画）
					used > 0
						? jsx("div", {
							className: "dsa-bar",
							children: jsx("div", {
								className: "dsa-bar-fill",
								style: {
									width: used + "%",
									background: used >= 70 ? "#d64545" : used >= 40 ? "#e08a00" : "#0a9e6a"
								}
							})
						})
						: null,
					item.badges && item.badges.length > 0
						? jsx("div", {
							className: "dsa-row",
							style: { marginTop: "6px", flexWrap: "wrap", gap: "4px" },
							children: item.badges.map((b, i) => jsx("span", {
								className: "dsa-badge",
								"data-level": b.level,
								children: b.text
							}, "b" + i))
						})
						: null,
					jsx("div", {
						className: "dsa-note",
						children: (
							// T+1 可卖是 A 股特有的约束，必须显式写出来
							"可卖 " + (item.tradable || 0) + " / 持有 " + (item.shares || 0) + " 股"
						)
					})
				]
			});
		}
		//#endregion

		//#region 组件：视图
		function PortfolioView({ data, onAsk }) {
			if (data.empty) {
				return jsx("div", {
					className: "dsa-empty",
					children: [
						jsx("div", { children: "当前空仓" }),
						jsx("div", {
							style: { marginTop: "6px" },
							children: "录入成交后再看这里：让助手执行 astock_record"
						}),
						jsx("div", {
							style: { marginTop: "6px" },
							children: "要配邮件通知或 Outlook 授权，去上面的「设置」页（不需要先有持仓）"
						}),
						onAsk
							? jsx("div", {
								style: { marginTop: "10px" },
								children: jsx(AskButton, {
									label: "让助手帮我录入持仓",
									onAsk: () => onAsk("帮我录入持仓：逐只告诉我代码、股数、成本价和买入日期，我先给你清单。")
								})
							})
							: null
					]
				});
			}
			return jsxs("div", {
				children: [
					jsx("div", {
						className: "dsa-kpis",
						children: (data.kpis || []).map((k, i) => jsx(KpiCard, { item: k }, "k" + i))
					}),
					jsx(Sparkline, { points: data.equityCurve || [] }),
					onAsk
						? jsx("div", {
							className: "dsa-actions",
							children: [
								jsx(AskButton, {
									label: "生成今日操作清单",
									onAsk: () => onAsk("用 astock_act 帮我生成今天的操作清单：先卖什么、再买什么、各多少股、止损止盈价，并说明理由。")
								}),
								jsx(AskButton, {
									label: "盘后复盘",
									onAsk: () => onAsk("用 astock_sentiment code=portfolio 做一份盘后舆情复盘：先给要点，再说背离，最后说明天要留意什么。")
								})
							]
						})
						: null,
					jsx("div", { className: "dsa-section", children: "持仓 · " + data.positionsTotal + " 只" }),
					(data.positions || []).map((p) => jsx(PositionCard, { item: p, onAsk }, p.code)),
					(data.watch || []).length > 0
						? jsxs("div", {
							children: [
								jsx("div", { className: "dsa-section", children: "自选观察" }),
								jsx("div", {
									className: "dsa-list",
									children: data.watch.map((w) => jsxs("div", {
										className: "dsa-line",
										children: [
											jsxs("span", {
												children: [
													jsx("span", { children: w.name }),
													jsx("span", { className: "dsa-code", style: { marginLeft: "5px" }, children: w.code })
												]
											}),
											jsxs("span", {
												className: "dsa-row",
												style: { gap: "6px" },
												children: [
													jsx("span", {
														className: trendClass(w.changePct),
														children: fmtMoney(w.price, 3) + "  " + fmtPct(w.changePct)
													}),
													onAsk
														? jsx(AskButton, {
															label: "看看",
															onAsk: () => onAsk("帮我看看 " + w.name + "（" + w.code + "）最近的走势、资金流和舆情，有没有值得关注的变化？")
														})
														: null
												]
											})
										]
									}, w.code))
								})
							]
						})
						: null,
					data.watchMissing > 0
						? jsx("div", {
							className: "dsa-note",
							children: "还有 " + data.watchMissing + " 只自选没取到行情（接口限流时会这样）"
						})
						: null,
					jsx("div", {
						className: "dsa-note",
						children: "止损 " + data.limits.stopLossPct + "% · 止盈 " + data.limits.takeProfitPct
							+ "% · 单票上限 " + data.limits.positionCapPct + "%"
					})
				]
			});
		}

		function StrategyCard({ item, onAsk }) {
			return jsxs("div", {
				className: "dsa-strategy",
				"data-default": item.isDefault ? "true" : "false",
				children: [
					jsxs("div", {
						className: "dsa-row",
						children: [
							jsx("span", { className: "dsa-name", children: item.label }),
							item.isDefault
								? jsx("span", { className: "dsa-badge", children: "默认策略" })
								: null,
							jsx("span", { className: "dsa-spacer" }),
							jsx("span", {
								className: "dsa-code",
								children: item.cached ? "缓存" : item.candidates + " 只入围"
							})
						]
					}),
					jsx("div", { className: "dsa-strategy-desc", children: item.description }),
					item.items.length === 0
						? jsx("div", { className: "dsa-note", children: "这一套本轮没有符合硬门槛的标的" })
						: item.items.map((p) => jsxs("div", {
							className: "dsa-pick",
							children: [
								jsxs("span", {
									children: [
										jsx("span", { children: p.name }),
										jsx("span", { className: "dsa-code", style: { marginLeft: "5px" }, children: p.code })
									]
								}),
								jsxs("span", {
									style: { textAlign: "right", display: "flex", gap: "6px", alignItems: "center", justifyContent: "flex-end" },
									children: [
										jsx("span", { children: fmtMoney(p.price, 2) + " × " + p.shares + " 股" }),
										jsx("span", {
											className: "dsa-code",
											children: "分 " + (p.score === null ? "—" : p.score)
										}),
										onAsk
											? jsx(AskButton, {
												label: "分析",
												onAsk: () => onAsk("分析 " + p.name + "（" + p.code + "）：K 线位置、资金流、舆情，"
													+ "以及它为什么被「" + item.label + "」策略选中？得分 " + (p.score === null ? "—" : p.score) + "。")
											})
											: null
									]
								})
							]
						}, p.code))
				]
			});
		}

		function PickView({ data, onAsk }) {
			if (!data.ok) return jsx(ErrorBlock, { data });
			return jsxs("div", {
				children: [
					(data.strategies || []).map((s) => jsx(StrategyCard, { item: s, onAsk }, s.key)),
					jsx("div", { className: "dsa-note", children: data.disclaimer })
				]
			});
		}

		function ErrorBlock({ data }) {
			return jsxs("div", {
				className: "dsa-error",
				children: [
					jsx("div", { children: data.error || "面板加载失败" }),
					data.hint ? jsx("div", { className: "dsa-note", children: data.hint }) : null
				]
			});
		}

		/**
		 * 通知视图：邮件配置体检 + 发测试邮件。
		 *
		 * 为什么放在面板而不是设置页：DSH 的设置页是**按 schema 自动生成**的纯表单，
		 * 放不了按钮；而"配了收不到"恰恰是最需要一次性验证的场景（SMTP 授权码、
		 * 端口、TLS 三件事错一个就静默失败），所以给一个能真发一封的地方。
		 */
		//#region 设置视图（邮件 / OAuth · 向导）
		/**
		 * 邮件设置：**向导式**，四步点完就能发信。
		 *
		 * 为什么做成向导：表单里 16 个字段一起摆出来，用户根本不知道该动哪个
		 * （Outlook 只要选服务商 + 填账号 + 授权，其余全自动）。所以主路径只问
		 * 三个问题，高级参数收进「高级设置（手动）」。
		 */
		function SettingsView({ data, reload }) {
			const [values, setValues] = react.useState(() => Object.assign({}, data.values || {}));
			const [step, setStep] = react.useState(0);
			const [busy, setBusy] = react.useState("");
			const [result, setResult] = react.useState(null);
			const [pending, setPending] = react.useState(data.oauth && data.oauth.pending || null);
			const [advanced, setAdvanced] = react.useState(false);

			react.useEffect(() => {
				setValues(Object.assign({}, data.values || {}));
				setPending(data.oauth && data.oauth.pending || null);
			}, [data]);

			const presets = data.presets || [];
			const presetKey = values.mail_preset || "outlook";
			const preset = presets.find((p) => p.key === presetKey) || presets[0]
				|| { key: "outlook", label: "Outlook / Hotmail", auth: "oauth2", hint: "" };
			const isOAuth = preset.auth === "oauth2";
			const authorized = Boolean(data.oauth && data.oauth.authorized);
			const account = String(values.mail_username || "").trim();
			const recipients = String(values.mail_to || "").trim() || account;

			const setValue = react.useCallback((key, value) => {
				setValues((prev) => Object.assign({}, prev, { [key]: value }));
			}, []);

			const run = react.useCallback((op, extra) => {
				setBusy(op);
				setResult(null);
				postPanel(op, extra)
					.then((payload) => {
						setResult(payload);
						if (op === "oauth_start" && payload && payload.ok) {
							setPending({
								userCode: payload.userCode,
								verificationUri: payload.verificationUri,
								message: payload.message
							});
						}
						if (op === "oauth_poll" && payload && payload.status === "done") {
							setPending(null);
							if (typeof reload === "function") reload();
						}
						if ((op === "settings_save" || op === "oauth_logout") && typeof reload === "function") reload();
					})
					.catch((error) => setResult({ ok: false, message: String(error && error.message || error) }))
					.finally(() => setBusy(""));
			}, [reload]);

			/** 选服务商：顺带把服务器/端口/认证方式定下来，后面不再问。 */
			const choosePreset = react.useCallback((key) => {
				const picked = presets.find((p) => p.key === key) || {};
				setValues((prev) => Object.assign({}, prev, {
					mail_preset: key,
					mail_auth: picked.auth || "basic",
					mail_host: picked.host || "",
					mail_port: picked.port || 587,
					mail_secure: Boolean(picked.secure)
				}));
				setResult(null);
				setStep(1);
			}, [presets]);

			/** 提交给宿主的 payload：预设服务商的服务器参数由服务端推导，这里清掉手填值。 */
			const buildPayload = react.useCallback(() => {
				const payload = {};
				for (const field of data.fields || []) {
					const value = values[field.key];
					if (field.type === "password" && value === "******") continue;
					payload[field.key] = value === undefined ? "" : value;
				}
				payload.mail_preset = presetKey;
				payload.mail_auth = preset.auth;
				if (presetKey !== "custom") {
					payload.mail_host = "";
					payload.mail_port = "";
					payload.mail_secure = "";
				}
				return payload;
			}, [data.fields, values, presetKey, preset.auth]);

			const save = react.useCallback(() => {
				run("settings_save", { values: buildPayload() });
			}, [buildPayload, run]);

			/** 保存 + 发一封测试邮件：一次点完，避免「改了没保存就测」。 */
			const saveAndTest = react.useCallback(() => {
				setBusy("mail_test");
				setResult(null);
				postPanel("settings_save", { values: buildPayload() })
					.then(() => postPanel("mail_test"))
					.then((payload) => {
						setResult(payload);
						if (typeof reload === "function") reload();
					})
					.catch((error) => setResult({ ok: false, message: String(error && error.message || error) }))
					.finally(() => setBusy(""));
			}, [buildPayload, reload]);

			/**
			 * 开始 OAuth 授权前**先保存账号**：授权完成后要把账号记进 oauth.json，
			 * 否则状态里只显示「已授权」却不知道授权的是哪个账号。
			 */
			const startOAuth = react.useCallback(() => {
				setBusy("oauth_start");
				setResult(null);
				postPanel("settings_save", { values: buildPayload() })
					.then(() => postPanel("oauth_start"))
					.then((payload) => {
						setResult(payload);
						if (payload && payload.ok) {
							setPending({
								userCode: payload.userCode,
								verificationUri: payload.verificationUri,
								message: payload.message
							});
						}
						if (typeof reload === "function") reload();
					})
					.catch((error) => setResult({ ok: false, message: String(error && error.message || error) }))
					.finally(() => setBusy(""));
			}, [buildPayload, reload]);

			const banner = result
				? jsx("div", {
					className: "dsa-banner",
					"data-ok": result.ok === false ? "false" : "true",
					children: (result.ok === false ? "❌ " : "✅ ") + (result.message || result.error || "完成")
				})
				: null;

			const steps = ["选服务商", "邮箱账号", "收件人", "完成"];

			// ── 其他配置（交易/风控/选股/盯盘）：分组折叠，默认收起 ──────────
			const GROUP_TITLES = {
				trade: "交易与费用",
				risk: "风控阈值",
				alert: "异动提醒",
				data: "取数与缓存",
				pick: "选股与回测",
				watch: "盯盘",
			};
			// 默认**展开**：之前默认收起，用户以为「配置只有邮件」，找不到这些项
			const [closedGroups, setClosedGroups] = react.useState({});
			const toggleGroup = (key) => setClosedGroups((prev) => Object.assign({}, prev, { [key]: !prev[key] }));
			const groupList = Object.keys(GROUP_TITLES)
				.map((key) => ({
					key,
					title: GROUP_TITLES[key],
					fields: (data.fields || []).filter((field) => field.section === key),
				}))
				.filter((group) => group.fields.length);

			// 宿主是旧版时只下发邮件字段：明确提示重启，别让人以为「配置只有邮件」
			const hasPluginSections = groupList.length > 0;

			/** 通用控件渲染（数字/文本/开关/分段选择）。 */
			const renderControl = (field) => {
				const value = values[field.key];
				if (field.type === "boolean") {
					return jsx("input", {
						type: "checkbox",
						checked: Boolean(value),
						onChange: (event) => setValue(field.key, event.target.checked)
					});
				}
				if (field.type === "select") {
					return jsx("div", {
						className: "dsa-seg",
						children: (field.options || []).map((option) => jsx("button", {
							type: "button",
							className: "dsa-seg-btn",
							"data-active": String(value) === String(option.value) ? "true" : "false",
							onClick: () => setValue(field.key, option.value),
							children: option.label
						}, option.value))
					});
				}
				return jsx("input", {
					className: "dsa-input",
					type: field.type === "number" ? "number" : "text",
					value: value === undefined || value === null ? "" : String(value),
					onChange: (event) => setValue(field.key, event.target.value)
				});
			};

			// ── 第 1 步：选服务商 ──────────────────────────────────
			const stepProvider = jsx("div", {
				className: "dsa-wiz-cards",
				children: presets.map((p) => jsxs("button", {
					type: "button",
					className: "dsa-wiz-card",
					"data-active": p.key === presetKey ? "true" : "false",
					onClick: () => choosePreset(p.key),
					children: [
						jsx("div", { className: "dsa-wiz-card-title", children: p.label }),
						jsx("div", { className: "dsa-wiz-card-hint", children: p.hint || "" })
					]
				}, p.key))
			});

			// ── 第 2 步：账号 + 授权 ───────────────────────────────
			const stepAccount = jsxs("div", {
				children: [
					jsx("div", { className: "dsa-field", children: jsx("label", { className: "dsa-field-label", children: "邮箱账号" }) }),
					jsx("input", {
						className: "dsa-input",
						type: "email",
						placeholder: "me@outlook.com",
						value: account,
						onChange: (event) => setValue("mail_username", event.target.value)
					}),
					jsx("div", {
						className: "dsa-field-hint",
						children: isOAuth ? "必须是你要授权的那个微软账号" : "填完整地址；授权码在服务商后台开启 SMTP 后生成"
					}),
					isOAuth
						? jsxs("div", {
							children: [
								jsx("div", { className: "dsa-section", children: "授权" }),
								jsxs("div", {
									className: "dsa-cell",
									children: [
										jsx("span", { children: "状态" }),
										jsx("span", {
											children: authorized
												? "✅ 已授权" + (data.oauth && data.oauth.account ? "（" + data.oauth.account + "）" : "")
												: "⚠️ 未授权"
										})
									]
								}),
								pending && pending.userCode
									? jsxs("div", {
										className: "dsa-banner",
										"data-ok": "true",
										children: [
											jsx("div", { children: "在浏览器打开下面的地址，输入代码完成授权：" }),
											jsx("a", {
												href: pending.verificationUri,
												target: "_blank",
												rel: "noreferrer",
												className: "dsa-mono",
												children: pending.verificationUri
											}),
											jsx("div", { className: "dsa-code-big", children: pending.userCode }),
											jsx("div", { className: "dsa-field-hint", children: "代码约 15 分钟有效，完成后点「我已完成授权」" })
										]
									})
									: null,
								jsxs("div", {
									className: "dsa-actions",
									children: [
										jsx("button", {
											className: "dsa-btn",
											disabled: Boolean(busy),
											onClick: startOAuth,
											children: busy === "oauth_start" ? "申请中…" : (pending ? "重新开始授权" : "开始授权")
										}),
										pending && pending.userCode
											? jsx("button", {
												className: "dsa-btn",
												disabled: Boolean(busy),
												onClick: () => run("oauth_poll"),
												children: busy === "oauth_poll" ? "检查中…" : "我已完成授权"
											})
											: null,
										authorized
											? jsx("button", {
												className: "dsa-btn",
												disabled: Boolean(busy),
												onClick: () => run("oauth_logout"),
												children: "清除授权"
											})
											: null
									]
								})
							]
						})
						: jsxs("div", {
							children: [
								jsx("div", { className: "dsa-field", children: jsx("label", { className: "dsa-field-label", children: "授权码 / 应用专用密码" }) }),
								jsx("input", {
									className: "dsa-input",
									type: "password",
									placeholder: "留空＝不修改",
									value: values.mail_password === "******" ? "" : (values.mail_password || ""),
									onChange: (event) => setValue("mail_password", event.target.value)
								}),
								jsx("div", { className: "dsa-field-hint", children: preset.hint || "" })
							]
						})
				]
			});

			// ── 第 3 步：收件人 ───────────────────────────────────
			const stepRecipient = jsxs("div", {
				children: [
					jsx("div", { className: "dsa-field", children: jsx("label", { className: "dsa-field-label", children: "收件人" }) }),
					jsx("input", {
						className: "dsa-input",
						type: "text",
						placeholder: account || "留空＝发给自己",
						value: values.mail_to || "",
						onChange: (event) => setValue("mail_to", event.target.value)
					}),
					jsx("div", { className: "dsa-field-hint", children: "多个用逗号分隔；留空就发到上面的邮箱账号" }),
					jsx("div", { className: "dsa-section", children: "通知开关" }),
					jsxs("label", {
						className: "dsa-row",
						style: { gap: "6px", fontSize: "12px" },
						children: [
							jsx("input", {
								type: "checkbox",
								checked: Boolean(values.mail_enabled),
								onChange: (event) => setValue("mail_enabled", event.target.checked)
							}),
							jsx("span", { children: "启用邮件通知（触发止损/止盈/异动时发信）" })
						]
					})
				]
			});

			// ── 第 4 步：完成 ─────────────────────────────────────
			const stepDone = jsxs("div", {
				children: [
					jsx("div", { className: "dsa-section", children: "确认一下" }),
					jsxs("div", {
						className: "dsa-list",
						children: [
							jsxs("div", { className: "dsa-cell", children: [jsx("span", { children: "服务商" }), jsx("span", { children: preset.label })] }),
							jsxs("div", { className: "dsa-cell", children: [jsx("span", { children: "认证" }), jsx("span", { children: isOAuth ? "OAuth2" + (authorized ? "（已授权）" : "（未授权）") : "授权码" })] }),
							jsxs("div", { className: "dsa-cell", children: [jsx("span", { children: "邮箱" }), jsx("span", { children: account || "（未填）" })] }),
							jsxs("div", { className: "dsa-cell", children: [jsx("span", { children: "收件人" }), jsx("span", { children: recipients || "（未填）" })] }),
							jsxs("div", { className: "dsa-cell", children: [jsx("span", { children: "通知" }), jsx("span", { children: values.mail_enabled ? "已启用" : "未启用" })] })
						]
					}),
					jsxs("div", {
						className: "dsa-actions",
						children: [
							jsx("button", {
								className: "dsa-btn",
								disabled: Boolean(busy),
								onClick: saveAndTest,
								children: busy === "mail_test" ? "保存并发送中…" : "保存并发送测试邮件"
							}),
							jsx("button", {
								className: "dsa-btn",
								disabled: Boolean(busy),
								onClick: save,
								children: busy === "settings_save" ? "保存中…" : "只保存"
							})
						]
					}),
					banner,
					jsx("div", {
						className: "dsa-note",
						children: "测试邮件收到就说明配置正确。真正的提醒只在盘中触发阈值时才发。"
					})
				]
			});

			const body = step === 0 ? stepProvider
				: step === 1 ? stepAccount
					: step === 2 ? stepRecipient
						: stepDone;

			return jsxs("div", {
				children: [
					step < 3
						? jsxs("div", {
							className: "dsa-wiz-steps",
							children: [
								jsx("span", { children: "第 " + (step + 1) + " / 4 步 · " + steps[step] }),
								jsx("span", { className: "dsa-spacer" }),
								jsx("button", {
									className: "dsa-ask",
									onClick: () => setAdvanced(!advanced),
									children: advanced ? "收起高级" : "高级设置（手动）"
								})
							]
						})
						: null,
					body,
					step < 3
						? jsxs("div", {
							className: "dsa-actions",
							children: [
								jsx("button", {
									className: "dsa-btn",
									disabled: step === 0 || Boolean(busy),
									onClick: () => setStep(step - 1),
									children: "上一步"
								}),
								jsx("button", {
									className: "dsa-btn",
									disabled: (step === 1 && (!account || (isOAuth && !authorized))) || Boolean(busy),
									onClick: () => setStep(step + 1),
									children: step === 2 ? "完成" : "下一步"
								})
							]
						})
						: jsx("div", {
							className: "dsa-actions",
							children: jsx("button", {
								className: "dsa-btn",
								disabled: Boolean(busy),
								onClick: () => setStep(0),
								children: "重新配置"
							})
						}),
					advanced
						? jsxs("div", {
							children: [
								jsx("div", { className: "dsa-section", children: "高级设置（手动）" }),
								(data.fields || []).map((field) => jsx("div", {
									className: "dsa-field",
									children: jsxs("div", {
									children: [
										jsx("label", { className: "dsa-field-label", children: field.label }),
										field.type === "boolean"
											? jsx("input", {
												type: "checkbox",
												checked: Boolean(values[field.key]),
												onChange: (event) => setValue(field.key, event.target.checked)
											})
											: field.type === "select"
												? jsx("div", {
													className: "dsa-seg",
													children: (field.options || []).map((option) => jsx("button", {
														type: "button",
														className: "dsa-seg-btn",
														"data-active": String(values[field.key]) === String(option.value) ? "true" : "false",
														onClick: () => setValue(field.key, option.value),
														children: option.label
													}, option.value))
												})
												: field.type === "preset"
													? jsx("div", {
														className: "dsa-seg",
														children: (field.options || []).map((option) => jsx("button", {
															type: "button",
															className: "dsa-seg-btn",
															"data-active": String(values[field.key]) === String(option.value) ? "true" : "false",
															onClick: () => choosePreset(option.value),
															children: option.label
														}, option.value))
													})
													: jsx("input", {
														className: "dsa-input",
														type: field.type === "number" ? "number" : (field.type === "password" ? "password" : "text"),
														placeholder: field.type === "password" ? "留空＝不修改" : "",
														value: field.type === "password" && values[field.key] === "******"
															? "" : (values[field.key] === undefined || values[field.key] === null ? "" : String(values[field.key])),
														onChange: (event) => setValue(field.key, event.target.value)
													}),
										field.hint ? jsx("div", { className: "dsa-field-hint", children: field.hint }) : null
									]
									})
								}, field.key)),
								jsxs("div", {
									className: "dsa-actions",
									children: [
										jsx("button", {
											className: "dsa-btn",
											disabled: Boolean(busy),
											onClick: save,
											children: "保存设置"
										}),
										jsx("button", {
											className: "dsa-btn",
											disabled: Boolean(busy),
											onClick: saveAndTest,
											children: busy === "mail_test" ? "发送中…" : "保存并发送测试邮件"
										})
									]
								}),
								banner,
								jsx("div", {
									className: "dsa-note",
									children: "这些值存在插件自己的 settings.json（与台账同目录），保存即生效，不用重启 DSH。"
								})
							]
						})
						: null,
					hasPluginSections
						? jsx("div", { className: "dsa-section", children: "其他配置（交易 / 风控 / 选股 / 盯盘）" })
						: jsx("div", {
							className: "dsa-banner",
							"data-ok": "false",
							children: "⚠️ 宿主插件还是旧版本：配置字段没有下发（只有邮件项）。"
								+ "请重启 DSH 后再打开本页；版本见页面底部。"
						}),
					groupList.map((group) => jsxs("div", {
						className: "dsa-group",
						children: [
							jsx("button", {
								type: "button",
								className: "dsa-group-head",
								onClick: () => toggleGroup(group.key),
								children: (closedGroups[group.key] ? "▸ " : "▾ ") + group.title
									+ "（" + group.fields.length + "）"
							}),
							!closedGroups[group.key]
								? jsx("div", {
									children: group.fields.map((field) => jsxs("div", {
										className: "dsa-field",
										children: [
											jsx("label", { className: "dsa-field-label", children: field.label }),
											renderControl(field),
											field.hint ? jsx("div", { className: "dsa-field-hint", children: field.hint }) : null
										]
									}, field.key))
								})
								: null
						]
					}, group.key)),
					jsxs("div", {
						className: "dsa-actions",
						children: [
							jsx("button", {
								className: "dsa-btn",
								disabled: Boolean(busy),
								onClick: save,
								children: busy === "settings_save" ? "保存中…" : "保存全部设置"
							}),
							jsx("button", {
								className: "dsa-btn",
								disabled: Boolean(busy),
								onClick: saveAndTest,
								children: busy === "mail_test" ? "发送中…" : "保存并发送测试邮件"
							})
						]
					}),
					banner,
					jsx("div", {
						className: "dsa-note",
						children: "插件版本 " + (data.version || "未知")
							+ "。保存即生效；如果这里只有邮件项，说明宿主还是旧版，重启 DSH 即可。"
					})
				]
			});
		}
		//#endregion

		function MailView({ data }) {
			const [busy, setBusy] = react.useState(false);
			const [result, setResult] = react.useState(null);

			const sendTest = react.useCallback(() => {
				setBusy(true);
				setResult(null);
				fetch(PANEL_URL, {
					method: "POST",
					headers: { "content-type": "application/json" },
					body: JSON.stringify({ op: "mail_test" })
				})
					.then(async (response) => {
						const payload = await response.json();
						setResult(payload);
					})
					.catch((error) => setResult({ ok: false, message: String(error && error.message || error) }))
					.finally(() => setBusy(false));
			}, []);

			const rows = [
				["状态", data.ready ? "✅ 可以发信" : ("⚠️ " + (data.reason || "未就绪"))],
				["启用", data.enabled ? "已启用" : "未启用"],
				["SMTP", (data.host || "—") + ":" + data.port + (data.secure ? "（隐式 TLS）" : "（STARTTLS）")],
				["发件人", data.sender || "—"],
				["收件人", (data.recipients || []).join(", ") || "—"],
				["通知阈值", data.minLevel],
				["去重 / 限流", "同一信号 " + data.dedupeHours + " 小时内只发一次，每小时最多 " + data.maxPerHour + " 封"]
			];

			return jsxs("div", {
				children: [
					data.settings && data.settings.configSchema === false
						? jsx("div", {
							className: "dsa-banner",
							"data-ok": "false",
							children: "配置表单未注册：" + (data.settings.error || "schemastery 未加载")
								+ "。请重启 DSH；仍不行就看 /api/dsh-astock/info 的 settingsError。"
						})
						: null,
					jsx("div", {
						className: "dsa-list",
						children: rows.map(([k, v]) => jsxs("div", {
							className: "dsa-cell",
							style: { padding: "3px 0" },
							children: [
								jsx("span", { children: k }),
								jsx("span", { style: { textAlign: "right", maxWidth: "62%" }, children: String(v) })
							]
						}, k))
					}),
					jsx("div", {
						style: { marginTop: "10px" },
						children: jsx("button", {
							className: "dsa-icon",
							style: { border: "1px solid var(--dsw-alias-border-l1)" },
							disabled: busy || !data.ready,
							onClick: sendTest,
							children: busy ? "发送中…" : "发一封测试邮件"
						})
					}),
					!data.ready
						? jsx("div", {
							className: "dsa-note",
							children: "到 侧栏「插件」→ 已安装插件 → dsh-astock → 配置，填 SMTP 服务器、账号与授权码，"
								+ "然后回到这里点测试。Outlook / Microsoft 365（含个人 Outlook.com）已逐步关闭 SMTP Basic Auth，"
								+ "应用专用密码也可能被拒（535 5.7.139）；被拒时请换一个支持 SMTP 授权码的发件邮箱，收件人仍可填 Outlook。"
						})
						: null,
					result
						? jsx("div", {
							className: result.ok ? "dsa-note" : "dsa-error",
							style: { marginTop: "8px" },
							children: (result.ok ? "✅ " : "❌ ") + (result.message || "")
						})
						: null,
					jsx("div", {
						className: "dsa-note",
						children: "邮件由插件自己定时判定（不消耗模型额度）：只在工作日 9:10–15:00 探测，"
							+ "只在触发阈值时发送。行情与台账工具不受影响。"
					})
				]
			});
		}
		//#endregion

		//#region 维护视图（存档 / 回测 / 自动化 / 导出 / 备份 / 导入）
		/** 面板 POST（维护动作统一走这里）。 */
		function postPanel(op, extra) {
			return fetch(PANEL_URL, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify(Object.assign({ op }, extra || {}))
			}).then(async (response) => {
				let payload = {};
				try {
					payload = await response.json();
				} catch (error) {
					payload = {};
				}
				if (!response.ok) {
					throw new Error(payload && payload.error ? payload.error : ("HTTP " + response.status));
				}
				return payload;
			});
		}

		function ImportPreview({ preview }) {
			const rows = (preview.rows || []).slice(0, 30);
			const statusText = { ok: "可导入", duplicate: "重复", error: "不通过" };
			return jsxs("div", {
				children: [
					jsx("div", { className: "dsa-note", children: preview.message || "" }),
					jsx("div", {
						className: "dsa-preview",
						children: rows.map((row, index) => jsxs("div", {
							className: "dsa-preview-row",
							"data-status": row.status,
							children: [
								jsx("span", {
									children: (row.trade_date || "") + " "
										+ (row.side === "buy" ? "买" : "卖") + " " + row.code
										+ " " + row.shares + " 股 @" + row.price
								}),
								jsx("span", {
									children: statusText[row.status]
										+ (row.problems && row.problems.length
											? "：" + row.problems.join("；")
											: "")
								})
							]
						}, "row" + index))
					}),
					(preview.rows || []).length > 30
						? jsx("div", { className: "dsa-note", children: "只显示前 30 行，共 " + preview.rows.length + " 行" })
						: null,
					(preview.errors || []).length > 0
						? jsx("div", { className: "dsa-note", children: preview.errors.slice(0, 5).join("；") })
						: null
				]
			});
		}

		/**
		 * 维护视图（重排后：状态 → 一键操作 → 备份迁移 → 导入 → 危险操作）。
		 *
		 * 之前所有按钮平铺在一起，用户找不到重点；现在按「看 / 做 / 搬 / 危险」
		 * 分区，导入与自愈默认收起——它们不是日常操作。
		 */
		function MaintView({ data, reload }) {
			const [busy, setBusy] = react.useState("");
			const [result, setResult] = react.useState(null);
			const [importText, setImportText] = react.useState("");
			const [preview, setPreview] = react.useState(null);
			const [confirmRestore, setConfirmRestore] = react.useState("");
			const [confirmRebuild, setConfirmRebuild] = react.useState(false);
			const [ledgerJson, setLedgerJson] = react.useState("");
			const [ledgerPreview, setLedgerPreview] = react.useState(null);
			const [ledgerScope, setLedgerScope] = react.useState("all");
			const [watchJson, setWatchJson] = react.useState("");
			const [planJson, setPlanJson] = react.useState("");
			const [openImports, setOpenImports] = react.useState(false);
			const [openDanger, setOpenDanger] = react.useState(false);

			const run = react.useCallback((op, extra) => {
				setBusy(op);
				setResult(null);
				postPanel(op, extra)
					.then((payload) => {
						setResult(payload);
						if (op === "import_trades" && payload && payload.committed === false) {
							setPreview(payload);
						}
						if (op === "import_trades" && payload && payload.committed === true) {
							setPreview(null);
						}
						if (payload && payload.ok !== false && typeof reload === "function") reload();
					})
					.catch((error) => setResult({ ok: false, message: String(error && error.message || error) }))
					.finally(() => setBusy(""));
			}, [reload]);

			if (!data.ok) return jsx(ErrorBlock, { data });

			const archive = data.archive || {};
			const backtest = data.backtest;
			const automation = data.automation || {};
			const report = automation.report || {};
			const backups = data.backups || [];
			const paths = data.paths || {};
			const ledger = data.ledger || {};

			const rows = (pairs) => jsx("div", {
				className: "dsa-list",
				children: pairs.map(([key, value]) => jsxs("div", {
					className: "dsa-cell",
					style: { padding: "3px 0" },
					children: [
						jsx("span", { children: key }),
						jsx("span", { style: { textAlign: "right", maxWidth: "62%" }, children: String(value) })
					]
				}, key))
			});

			return jsxs("div", {
				children: [
					result
						? jsx("div", {
							className: "dsa-banner",
							"data-ok": result.ok === false ? "false" : "true",
							children: (result.ok === false ? "❌ " : "✅ ")
								+ (result.message || result.error || "完成")
						})
						: null,

					// ── 1. 状态（看）─────────────────────────────────
					jsx("div", { className: "dsa-section", children: "状态" }),
					rows([
						["本地存档", (archive.codes || 0) + " 只 / " + (archive.bars || 0).toLocaleString("zh-CN") + " 根"],
						["存档区间", (archive.first_date || "—") + " → " + (archive.last_date || "—")],
						["台账", (ledger.positions || 0) + " 只持仓 · " + (ledger.trades || 0) + " 笔流水"],
						["上次自动存档", fmtDateTime(automation.lastRunAt)],
						["盘后报告", report.active ? "已启用（工作日 15:05）" : "未创建"],
						["最近回测", backtest ? (backtest.label || backtest.strategy || "—")
							+ " · 推荐率 " + (backtest.winRate === null || backtest.winRate === undefined ? "—" : backtest.winRate + "%")
							: "还没跑过"]
					]),

					// ── 2. 一键操作（做）─────────────────────────────
					jsx("div", { className: "dsa-section", children: "一键操作" }),
					jsxs("div", {
						className: "dsa-actions",
						children: [
							jsx("button", {
								className: "dsa-btn",
								disabled: Boolean(busy),
								onClick: () => run("archive_update"),
								children: busy === "archive_update" ? "更新中…" : "更新存档"
							}),
							jsx("button", {
								className: "dsa-btn",
								disabled: Boolean(busy),
								onClick: () => run("backtest_run", { strategy: data.strategy }),
								children: busy === "backtest_run" ? "回测中（6–14 秒）…" : "跑一轮回测"
							}),
							jsx("button", {
								className: "dsa-btn",
								disabled: Boolean(busy),
								onClick: () => run("report_send"),
								children: busy === "report_send" ? "生成中…" : "发一份复盘邮件"
							})
						]
					}),
					jsx("div", {
						className: "dsa-note",
						children: "更新存档只存不复权原始价：今天开始存，一年后才多一年历史。回测与复盘都不消耗模型额度。"
					}),

					// ── 3. 备份与迁移（搬）───────────────────────────
					jsx("div", { className: "dsa-section", children: "备份与迁移" }),
					jsxs("div", {
						className: "dsa-actions",
						children: [
							jsx("a", { className: "dsa-btn", href: PANEL_URL + "?download=ledger.json", children: "导出台账 JSON" }),
							jsx("a", { className: "dsa-btn", href: PANEL_URL + "?download=trades.csv", children: "导出成交 CSV" }),
							jsx("a", { className: "dsa-btn", href: PANEL_URL + "?download=watchlist.json", children: "导出自选" }),
							jsx("a", { className: "dsa-btn", href: PANEL_URL + "?download=watch-plan.json", children: "导出盯盘规则" }),
							jsx("button", {
								className: "dsa-btn",
								disabled: Boolean(busy),
								onClick: () => run("backup_create"),
								children: busy === "backup_create" ? "备份中…" : "备份台账+存档"
							})
						]
					}),
					backups.length === 0
						? jsx("div", { className: "dsa-note", children: "还没有备份。备份包含台账、存档、收盘净值与最近回测。" })
						: jsx("div", {
							style: { marginTop: "6px" },
							children: backups.map((backup) => jsxs("div", {
								className: "dsa-line",
								children: [
									jsx("span", {
										children: backup.name + (backup.createdAt ? "（" + String(backup.createdAt).slice(5, 16) + "）" : "")
									}),
									confirmRestore === backup.name
										? jsxs("span", {
											className: "dsa-row",
											style: { gap: "4px" },
											children: [
												jsx("button", {
													className: "dsa-ask",
													onClick: () => {
														setConfirmRestore("");
														run("backup_restore", { name: backup.name });
													},
													children: "确认恢复"
												}),
												jsx("button", {
													className: "dsa-ask",
													onClick: () => setConfirmRestore(""),
													children: "取消"
												})
											]
										})
										: jsx("button", {
											className: "dsa-ask",
											onClick: () => setConfirmRestore(backup.name),
											children: "恢复"
										})
								]
							}, backup.name))
						}),

					// ── 4. 导入（折叠）───────────────────────────────
					jsx("button", {
						type: "button",
						className: "dsa-group-head",
						onClick: () => setOpenImports(!openImports),
						children: (openImports ? "▾ " : "▸ ") + "导入（成交 CSV / 台账 JSON / 自选 / 盯盘规则）"
					}),
					openImports
						? jsxs("div", {
							children: [
								jsx("div", { className: "dsa-note", children: "成交 CSV：首行表头，例：成交日期,代码,方向,成交价,数量,费用" }),
								jsx("textarea", {
									className: "dsa-textarea",
									value: importText,
									placeholder: "2026-11-05,600000,买入,10.00,1000,5.1",
									onChange: (event) => {
										setImportText(event.target.value);
										setPreview(null);
									}
								}),
								jsxs("div", {
									className: "dsa-actions",
									children: [
										jsx("button", {
											className: "dsa-btn",
											disabled: Boolean(busy) || !importText.trim(),
											onClick: () => run("import_trades", { text: importText, commit: false }),
											children: busy === "import_trades" ? "校验中…" : "预览校验"
										}),
										jsx("button", {
											className: "dsa-btn",
											disabled: Boolean(busy) || !preview || !preview.summary || preview.summary.ok === 0,
											onClick: () => run("import_trades", { text: importText, commit: true }),
											children: "确认导入"
										})
									]
								}),
								preview ? jsx(ImportPreview, { preview }) : null,

								jsx("div", { className: "dsa-section", children: "从台账 JSON 恢复" }),
								jsx("textarea", {
									className: "dsa-textarea",
									value: ledgerJson,
									placeholder: "粘贴 astock-ledger-*.json 的内容",
									onChange: (event) => {
										setLedgerJson(event.target.value);
										setLedgerPreview(null);
									}
								}),
								jsx("div", {
									className: "dsa-seg",
									style: { marginTop: "6px" },
									children: [
										["all", "全量"],
										["watch_cash", "资金+自选"],
										["trades", "仅成交"]
									].map(([key, label]) => jsx("button", {
										type: "button",
										className: "dsa-seg-btn",
										"data-active": ledgerScope === key ? "true" : "false",
										onClick: () => {
											setLedgerScope(key);
											setLedgerPreview(null);
										},
										children: label
									}, key))
								}),
								jsxs("div", {
									className: "dsa-actions",
									children: [
										jsx("button", {
											className: "dsa-btn",
											disabled: Boolean(busy) || !ledgerJson.trim(),
											onClick: () => run("ledger_import_preview", { text: ledgerJson, scope: ledgerScope }),
											children: busy === "ledger_import_preview" ? "对比中…" : "预览差异"
										}),
										jsx("button", {
											className: "dsa-btn",
											disabled: Boolean(busy) || !ledgerPreview || ledgerPreview.ok === false,
											onClick: () => {
												setLedgerPreview(null);
												run("ledger_import_commit", { text: ledgerJson, scope: ledgerScope });
											},
											children: "确认恢复"
										})
									]
								}),
								ledgerPreview
									? jsx("div", {
										className: "dsa-banner",
										"data-ok": ledgerPreview.ok === false ? "false" : "true",
										children: ledgerPreview.ok === false
											? "❌ " + (ledgerPreview.message || (ledgerPreview.errors || []).join("；"))
											: "预览：持仓 +" + ledgerPreview.positions.add.length
												+ " / 改 " + ledgerPreview.positions.update.length
												+ " / 清 " + ledgerPreview.positions.remove.length
												+ "；成交新增 " + ledgerPreview.trades.new
												+ "（重复 " + ledgerPreview.trades.duplicate + "）"
												+ "；自选 +" + ledgerPreview.watchlist.add.length
												+ "；资金 " + ledgerPreview.cash.before
												+ (ledgerPreview.cash.after === null ? "（不变）" : " → " + ledgerPreview.cash.after)
									})
									: null,

								jsx("div", { className: "dsa-section", children: "自选 / 盯盘规则" }),
								jsx("textarea", {
									className: "dsa-textarea",
									value: watchJson,
									placeholder: "粘贴自选 JSON（[\"600000\"] 或导出文件）",
									onChange: (event) => setWatchJson(event.target.value)
								}),
								jsxs("div", {
									className: "dsa-actions",
									children: [
										jsx("button", {
											className: "dsa-btn",
											disabled: Boolean(busy) || !watchJson.trim(),
											onClick: () => run("watchlist_import", { text: watchJson, commit: false }),
											children: "预览自选"
										}),
										jsx("button", {
											className: "dsa-btn",
											disabled: Boolean(busy) || !watchJson.trim(),
											onClick: () => run("watchlist_import", { text: watchJson, commit: true }),
											children: "导入自选"
										})
									]
								}),
								jsx("textarea", {
									className: "dsa-textarea",
									value: planJson,
									placeholder: "粘贴盯盘规则 JSON（astock-watch-plan-*.json）",
									onChange: (event) => setPlanJson(event.target.value)
								}),
								jsx("div", {
									className: "dsa-actions",
									children: jsx("button", {
										className: "dsa-btn",
										disabled: Boolean(busy) || !planJson.trim(),
										onClick: () => run("plan_import", { text: planJson }),
										children: busy === "plan_import" ? "导入中…" : "导入盯盘规则"
									})
								})
							]
						})
						: null,

					// ── 5. 危险操作（折叠）───────────────────────────
					jsx("button", {
						type: "button",
						className: "dsa-group-head",
						onClick: () => setOpenDanger(!openDanger),
						children: (openDanger ? "▾ " : "▸ ") + "危险操作"
					}),
					openDanger
						? jsxs("div", {
							children: [
								jsx("div", {
									className: "dsa-note",
									children: "按全部成交流水重放，重建持仓与移动加权成本。导入/删流水后持仓对不上时用它；"
										+ "没有流水的持仓会原样保留。"
								}),
								jsx("div", {
									className: "dsa-actions",
									children: confirmRebuild
										? jsx("button", {
											className: "dsa-btn",
											disabled: Boolean(busy),
											onClick: () => {
												setConfirmRebuild(false);
												run("ledger_rebuild");
											},
											children: "确认重算"
										})
										: jsx("button", {
											className: "dsa-btn",
											disabled: Boolean(busy),
											onClick: () => setConfirmRebuild(true),
											children: "按流水重算持仓"
										})
								})
							]
						})
						: null,

					jsx("div", { className: "dsa-note", children: data.disclaimer || "" })
				]
			});
		}
		//#endregion

		//#region 面板主体
		/**
		 * 右栏面板。
		 *
		 * 数据来自宿主注册的 `GET /api/dsh-astock/panel`；**不在打开时自动刷新**
		 * （选股会真扫全市场），由用户点「刷新」触发。持仓视图首次打开会取一次。
		 */
		function AstockPanel(props) {
			const [view, setView] = react.useState("portfolio");
			const [state, setState] = react.useState({ loading: true, data: null, error: "" });
			/** 每次请求的序号：后发的请求才允许写回，避免切换视图时旧结果覆盖新结果。 */
			const seq = react.useRef(0);
			/**
			 * 把问题写进输入框（不自动发送）。
			 *
			 * `inputActions` 是右栏 tab 的标准 prop；拿不到时按钮点了没反应，
			 * 但面板其余部分照常工作（预览/独立运行等场景）。
			 */
			const onAsk = react.useCallback((text) => {
				askWith(props && props.inputActions, text);
			}, [props && props.inputActions]);

			const load = react.useCallback((target, fresh) => {
				const ticket = ++seq.current;
				setState((prev) => ({ loading: true, data: prev.data, error: "" }));
				const controller = new AbortController();
				const query = "?panel=" + encodeURIComponent(target) + (fresh ? "&fresh=1" : "");
				fetch(PANEL_URL + query, { signal: controller.signal })
					.then(async (response) => {
						if (!response.ok) throw new Error("HTTP " + response.status);
						const payload = await response.json();
						if (ticket !== seq.current) return;
						if (payload && payload.ok === false && payload.error) {
							setState({ loading: false, data: null, error: payload.error });
							return;
						}
						// 视图对不上 = 宿主还在跑旧版插件（旧端点不认识 panel=settings，
						// 会回落到 portfolio）。这时千万别把持仓数据当成设置页渲染，
						// 否则用户看到的是「录入成交后再看这里」，完全摸不着头脑。
						if (payload && payload.view && payload.view !== target) {
							setState({
								loading: false,
								data: null,
								error: "宿主插件还是旧版本（请求 " + target + "，返回 " + payload.view
									+ "）。请重启 DSH，让新代码生效后再打开本页。"
							});
							return;
						}
						setState({ loading: false, data: payload, error: "" });
					})
					.catch((error) => {
						if (error && error.name === "AbortError") return;
						if (ticket !== seq.current) return;
						setState({ loading: false, data: null, error: String(error && error.message || error) });
					});
				return () => controller.abort();
			}, []);

			react.useEffect(() => {
				const cancel = load(view);
				return cancel;
			}, [view, load]);

			const data = state.data;
			// 没有 inputActions 时不渲染「分析」按钮：点了没反应比没有按钮更糟
			const ask = props && props.inputActions ? onAsk : null;
			const body = state.loading && !data
				? jsx("div", { className: "dsa-empty", children: "加载中…" })
				: state.error
					? jsx(ErrorBlock, { data: { error: state.error } })
					: data && data.view === "pick"
						? jsx(PickView, { data, onAsk: ask })
						: data && data.view === "settings"
							? jsx(SettingsView, { data, reload: () => load("settings") })
							: data && data.view === "mail"
								? jsx(MailView, { data })
								: data && data.view === "maint"
									? jsx(MaintView, { data, reload: () => load("maint") })
									: data
										? jsx(PortfolioView, { data, onAsk: ask })
										: jsx("div", { className: "dsa-empty", children: "还没有数据" });

			return jsxs("div", {
				className: "dsa-root",
				children: [
					jsxs("div", {
						className: "dsa-head",
						children: [
							VIEWS.map((v) => jsx("button", {
								className: "dsa-tab",
								"data-active": view === v.key ? "true" : "false",
								onClick: () => setView(v.key),
								children: v.label
							}, v.key)),
							jsx("span", { className: "dsa-spacer" }),
							data && data.renderedAt
								? jsx("span", { className: "dsa-code", children: data.renderedAt.slice(11) })
								: null,
							jsx("button", {
								className: "dsa-icon",
								title: view === "pick" ? "重新扫描全市场（数秒）"
									: view === "maint" ? "刷新维护状态（不联网）"
										: "刷新持仓",
								disabled: state.loading,
								onClick: () => load(view, view === "pick"),
								children: state.loading ? "…" : "刷新"
							})
						]
					}),
					jsx("div", { className: "dsa-body", children: body })
				]
			});
		}
		//#endregion

		//#region 注册
		/** 本插件的页面类型定义（不打开任何资源，只能按 kind 打开）。 */
		function definition() {
			return {
				id: ID,
				kind: KIND,
				// 新能力用 extension 优先级；kind 里没有 builtin 竞争，谁在谁生效
				priority: "extension",
				title: () => "A股",
				guide: [{
					id: "panel",
					order: 50,
					title: () => "A股助手",
					description: () => "持仓卡片（浮盈 / 占比 / 止损余量）与三套策略选股对比"
				}]
			};
		}

		const inject = ["slots", "sidebarRightTabs"];

		/**
		 * 装进浏览器端。
		 * @param ctx - 带 slots / sidebarRightTabs 服务的客户端 Cordis 上下文
		 */
		function apply(ctx) {
			ensureCss();
			// 两段注册同属一个 effect：插件卸载时类型与 body 一起消失
			ctx.effect(() => ctx.sidebarRightTabs.register(definition()), "dsh-astock: tab type");
			ctx.effect(() => ctx.slots.inject("sidebar.right.pane.tab", () => ctx.slots.register({
				name: "sidebar.right.pane.tab",
				key: ID
			}, AstockPanel)), "dsh-astock: panel body");
		}
		//#endregion

		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	}
});
