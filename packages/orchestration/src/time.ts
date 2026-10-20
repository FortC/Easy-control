/** 时区工具：数据库存 UTC，界面按工作空间时区展示（方案 §8）。 */

/** 把「本地日期 + HH:mm（工作空间时区）」换算为 UTC 时间。 */
export function zonedTimeToUtc(localDateYMD: string, timeOfDay: string, timeZone: string): Date {
  const naive = new Date(`${localDateYMD}T${timeOfDay}:00Z`); // 先当作 UTC
  const offsetMs = zoneOffsetMs(naive, timeZone);
  return new Date(naive.getTime() - offsetMs);
}

function zoneOffsetMs(instant: Date, timeZone: string): number {
  const dtf = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });
  const parts = dtf.formatToParts(instant);
  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value ?? "0");
  const asUtc = Date.UTC(
    get("year"),
    get("month") - 1,
    get("day"),
    get("hour") % 24,
    get("minute"),
    get("second"),
  );
  return asUtc - instant.getTime();
}

/** 给定 UTC 瞬间，返回该时区的「日期 + 星期（1=周一…7=周日）」。 */
export function zonedWeekday(instant: Date, timeZone: string): { dateYMD: string; weekday: number } {
  const dtf = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    weekday: "short",
  });
  const parts = dtf.formatToParts(instant);
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "";
  const dateYMD = `${get("year")}-${get("month")}-${get("day")}`;
  const weekdayNames: Record<string, number> = { Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6, Sun: 7 };
  return { dateYMD, weekday: weekdayNames[get("weekday")] ?? 1 };
}

/** 当前时刻在指定时区的日期（YYYY-MM-DD）。 */
export function zonedToday(timeZone: string, instant = new Date()): string {
  return zonedWeekday(instant, timeZone).dateYMD;
}

/** 日期加一天（YYYY-MM-DD）。 */
export function addDaysYMD(dateYMD: string, days: number): string {
  const date = new Date(`${dateYMD}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}
