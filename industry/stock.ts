// Personal collection policy; these ranks only select documents to READ, not scores for publication.
export const STOCK = {
  announcementsPerDay: 24, // Rolling 24 hours, including failed attempts.
  announcementsPerWindow: 12, // Each Beijing 20:00–08:00 / 08:00–20:00 window.
  announcementLookbackHours: 72,
  announcementPagesPerRun: 6,
  hongKongPagesPerRun: 3, // 500 index entries per page, with a repeated head read.
  hongKongDocumentsPerDay: 6, // Part of the shared rolling 24-document limit.
  indexRetentionDays: 30,
  eventRetentionDays: 7,
  // Provider-defined events, recorded as observations without inferring their cause.
  eventTypes: { "8201": "火箭发射", "8204": "加速下跌", "4": "封涨停板", "8": "封跌停板", "16": "打开涨停板", "32": "打开跌停板" },
  announcementRules: [
    { pattern: "退市|立案调查|重大违法|债务违约|重大诉讼|重大风险|停产|重大事故", priority: 30 },
    { pattern: "重大资产重组|发行股份购买|控制权变更|重大合同|重大订单|业绩预告|业绩快报|预亏|扭亏", priority: 20 },
    { pattern: "年度报告摘要|半年度报告摘要|季度报告|回购股份|收购.*股权|重大投资", priority: 10 },
  ],
  hongKongAnnouncementRules: [
    { pattern: "取消上市|除牌|清盤|破產|違約|重大訴訟|重大事故|盈利警告|停牌|暫停買賣|復牌", priority: 30 },
    { pattern: "內幕消息|盈利預告|盈喜|年度業績|全年業績|中期業績|季度業績|重大交易|非常重大|收購|出售.*資產|重大合同|重大合約|控制權", priority: 20 },
  ],
} as const;

export function announcementPriority(title: string): number {
  return STOCK.announcementRules.find((r) => new RegExp(r.pattern).test(title))?.priority ?? 0;
}

export function hongKongAnnouncementPriority(title: string): number {
  return STOCK.hongKongAnnouncementRules.find((r) => new RegExp(r.pattern).test(title))?.priority ?? 0;
}
