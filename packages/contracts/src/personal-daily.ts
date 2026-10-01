export type DailyEdition = "morning" | "evening";

export function validDailyEdition(value: string): value is DailyEdition {
  return value === "morning" || value === "evening";
}

export function dailyEditionKey(date: string, edition?: DailyEdition): string {
  return edition ? `${date}:${edition}` : date;
}

export function dailyEditionLabel(edition?: DailyEdition): string {
  return edition === "morning" ? "早报" : edition === "evening" ? "晚报" : "日报";
}
