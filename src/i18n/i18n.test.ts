import en from "./en.json";
import es from "./es.json";
import { detectLanguage, format, translate } from "./index";

it("Spanish and English have exactly the same keys, with the same shape", () => {
  const shape = (messages: Record<string, unknown>) =>
    Object.entries(messages)
      .map(([key, value]) =>
        typeof value === "string"
          ? key
          : `${key}:${Object.keys(value as object)}`,
      )
      .sort();
  expect(shape(en)).toEqual(shape(es));
});

it("no text is empty", () => {
  for (const value of [...Object.values(es), ...Object.values(en)]) {
    expect(JSON.stringify(value)).not.toMatch(/""/);
  }
});

it("fills in {placeholders} and leaves unknown ones", () => {
  expect(format("Hola, {name}: {name}", "es", { name: "Ana" })).toBe(
    "Hola, Ana: Ana",
  );
  expect(format("{done} of {total}", "en", { done: 2, total: 5 })).toBe(
    "2 of 5",
  );
  expect(format("Missing {x}", "en")).toBe("Missing {x}");
});

it("picks the plural form for the language", () => {
  const es = { one: "{count} descarga", other: "{count} descargas" };
  const en = { one: "{count} download", other: "{count} downloads" };
  expect(format(es, "es", { count: 1 })).toBe("1 descarga");
  expect(format(es, "es", { count: 0 })).toBe("0 descargas");
  expect(format(es, "es", { count: 3 })).toBe("3 descargas");
  expect(format(en, "en", { count: 1 })).toBe("1 download");
  expect(format(en, "en", { count: 0 })).toBe("0 downloads");
  expect(format(en, "en", { count: 1.5 })).toBe("1.5 downloads");
});

it("detects the system language: Spanish variants are Spanish, the rest English", () => {
  expect(detectLanguage("es")).toBe("es");
  expect(detectLanguage("es-MX")).toBe("es");
  expect(detectLanguage("ES-es")).toBe("es");
  expect(detectLanguage("en-US")).toBe("en");
  expect(detectLanguage("fr")).toBe("en");
  expect(detectLanguage("")).toBe("en");
});

it("translates a key", () => {
  expect(translate("es", "toolbar.pasteLink")).toBe("Pegar enlace");
  expect(translate("en", "toolbar.pasteLink")).toBe("Paste link");
});
