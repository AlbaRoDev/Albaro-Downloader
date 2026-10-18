import { SEASONS, type Season, seasonFor } from "./seasons";

// [month (1-12), day, season]: the website's calendar, edges included.
const CALENDAR: [number, number, Season][] = [
  [1, 1, "christmas"],
  [1, 6, "christmas"],
  [1, 7, "winter"],
  [2, 14, "winter"],
  [3, 19, "winter"],
  [3, 20, "spring"],
  [3, 28, "spring"],
  [3, 29, "easter"],
  [4, 5, "easter"],
  [4, 6, "spring"],
  [5, 31, "spring"],
  [6, 1, "spring"],
  [6, 2, "anniversary"],
  [6, 3, "spring"],
  [6, 21, "spring"],
  [6, 22, "summer"],
  [7, 1, "summerSun"],
  [7, 15, "summerSun"],
  [7, 16, "summer"],
  [8, 31, "summer"],
  [9, 23, "summer"],
  [9, 24, "autumn"],
  [10, 15, "autumn"],
  [10, 29, "autumn"],
  [10, 30, "halloween"],
  [10, 31, "halloween"],
  [11, 1, "halloween"],
  [11, 2, "autumn"],
  [12, 14, "autumn"],
  [12, 15, "christmas"],
  [12, 31, "christmas"],
];

describe("seasonFor", () => {
  it.each(CALENDAR)("%i/%i is %s", (month, day, season) => {
    expect(seasonFor(new Date(2026, month - 1, day))).toBe(season);
  });

  it("answers every day of the year, with every season somewhere, in leap years too", () => {
    const seen = new Set<Season>();
    for (const year of [2026, 2028]) {
      for (
        let d = new Date(year, 0, 1);
        d.getFullYear() === year;
        d.setDate(d.getDate() + 1)
      ) {
        seen.add(seasonFor(d));
      }
    }
    expect([...seen].sort()).toEqual([...SEASONS].sort());
  });

  it("the time of day does not matter", () => {
    expect(seasonFor(new Date(2026, 9, 30, 0, 0, 0))).toBe("halloween");
    expect(seasonFor(new Date(2026, 9, 29, 23, 59, 59))).toBe("autumn");
  });
});
