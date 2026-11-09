import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync } from "node:fs";
import { isIPv4 } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import fc from "fast-check";
import { afterEach, describe, expect, it, onTestFinished, vi } from "vitest";
import { DEFAULT_RULES, type Rule } from "../../src/core/config.ts";
import { Masker } from "../../src/core/masker.ts";
import type { PayloadFormat } from "../../src/core/payload.ts";
import type { RandomBytes } from "../../src/core/shape.ts";
import { ScanError, Scanner } from "../../src/core/scanner.ts";
import { Vault } from "../../src/core/vault.ts";

function seeded(seed: string): RandomBytes {
  let counter = 0;
  return (size) => {
    let bytes = Buffer.alloc(0);
    while (bytes.length < size)
      bytes = Buffer.concat([
        bytes,
        createHash("sha256").update(`${seed}${counter++}`).digest(),
      ]);
    return bytes.subarray(0, size);
  };
}

const NO_FORMAT: PayloadFormat = { opaque: () => false };

const ALNUM = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";

/** Random alphanumeric text of `length`, drawn from `random`. */
function word(random: RandomBytes, length: number): string {
  return [...random(length)]
    .map((byte) => ALNUM.charAt(byte % ALNUM.length))
    .join("");
}

const base64 = (text: string): string => Buffer.from(text).toString("base64");

/** Breaks `encoded` into lines of `width` characters, joined by newlines. */
function wrap(encoded: string, width: number): string {
  return Array.from(
    encoded.matchAll(new RegExp(`.{1,${width}}`, "g")),
    ([line]) => line,
  ).join("\n");
}

function literal(
  id: string,
  values: string[],
  strategy: Rule["strategy"] = "opaque",
  replacement?: string,
): Rule {
  return { id, type: "literal", enabled: true, strategy, values, replacement };
}

function regex(id: string, pattern: string): Rule {
  return {
    id,
    type: "regex",
    enabled: true,
    strategy: "opaque",
    pattern,
    flags: "",
    group: 0,
  };
}

let scanner: Scanner | undefined;
afterEach(() => {
  scanner?.close();
  scanner = undefined;
});

function build(
  rules: readonly Rule[],
  vault = new Vault(seeded("masker")),
  env: Record<string, string | undefined> = {},
  format = NO_FORMAT,
): { masker: Masker; vault: Vault } {
  scanner = new Scanner(2000);
  return { masker: new Masker(rules, scanner, vault, env, format), vault };
}

describe("Masker rules", () => {
  it("masks contextual card codes and the next card through the default rules", async () => {
    const { masker } = build(DEFAULT_RULES);
    const first = "4271 5686 2827 7212 412";
    const second = "5156 3777 8930 3107";
    const text = `card=${first} ${second}`;
    const [masked] = await masker.mask([text]);
    expect(masked).toMatch(/^card=/);
    expect(masked).not.toContain(first);
    expect(masked).not.toContain(second);
    expect(masker.restoreValue(masked)).toBe(text);
  });

  it("masks an unquoted keyed value with punctuation in full", async () => {
    const { masker } = build(DEFAULT_RULES);
    const random = seeded("keyed-punctuation");
    const value = `${word(random, 6)}.${word(random, 4)}!${word(random, 3)}`;
    const text = `DB_PASSWORD=${value}`;
    const [masked] = await masker.mask([text]);
    expect(masked).not.toContain(value);
    for (let i = 0; i + 4 <= value.length; i++)
      expect(masked).not.toContain(value.slice(i, i + 4));
    expect(masker.restoreValue(masked)).toBe(text);
  });

  it("masks only the keyed value in a command line or a sentence", async () => {
    const { masker } = build(DEFAULT_RULES);
    const random = seeded("keyed-mid-line");
    for (const [head, tail] of [
      ["DB_PASSWORD=", " psql -h db app"],
      ["export DB_PASSWORD=", "; echo ok"],
      ["The password: ", " works, see the docs."],
    ]) {
      const value = `${word(random, 6)}.${word(random, 4)}!${word(random, 3)}`;
      const text = `${head}${value}${tail}`;
      const [masked] = await masker.mask([text]);
      expect(masked.startsWith(head), masked).toBe(true);
      expect(masked.endsWith(tail), masked).toBe(true);
      expect(masked).toHaveLength(text.length);
      for (let i = 0; i + 4 <= value.length; i++)
        expect(masked).not.toContain(value.slice(i, i + 4));
      expect(masker.restoreValue(masked)).toBe(text);
    }
  });

  it("masks an email address so that the part after @ restores to the domain alone", async () => {
    const { masker } = build(DEFAULT_RULES);
    const [masked] = await masker.mask([
      "support: vttgdn.cygofv505@uuwuix-vehagu.fr",
    ]);
    const domain = masked.split("@")[1];
    expect(domain).not.toBe("uuwuix-vehagu.fr");
    expect(masker.restoreValue(`domain ${domain}`)).toBe(
      "domain uuwuix-vehagu.fr",
    );
  });

  it("restores the domain of an email fake written with a subdomain before it", async () => {
    const { masker } = build(DEFAULT_RULES);
    const [masked] = await masker.mask(["support: ana@uuwuix-vehagu.fr"]);
    const domain = masked.split("@")[1];
    expect(masker.restoreValue(`curl https://www.${domain}/x`)).toBe(
      "curl https://www.uuwuix-vehagu.fr/x",
    );
  });

  it("keeps a common domain after masking an email at it", async () => {
    const { masker } = build(DEFAULT_RULES);
    await masker.mask(["GitHub <noreply@github.com>"]);
    expect(await masker.mask(["see github.com/acme"])).toEqual([
      "see github.com/acme",
    ]);
  });

  it("masks caseless and supplementary letters through the vault and restores them", async () => {
    const { masker } = build([literal("unicode", ["中文", "𐐀"])]);
    const [masked] = await masker.mask(["中文 𐐀"]);
    expect(masked).toMatch(/^[A-Za-z0-9]{2} [A-Za-z0-9]{2}$/);
    expect(masker.restoreValue(masked)).toBe("中文 𐐀");
  });
  it("applies default validators before learning or replacing values", async () => {
    const { masker, vault } = build(DEFAULT_RULES);
    const text =
      "private 10.0.0.5 host db.internal:5432 order 4111 1111 1111 1112 ref";
    expect(await masker.mask([text])).toEqual([text]);
    expect(vault.entries()).toEqual([]);
  });
  it("preserves the winning shape rule when rematching an earlier bare value", async () => {
    const value = "ABCDEFGHIJKL";
    const shape: Rule = {
      id: "shape",
      type: "keyed",
      enabled: true,
      strategy: "shape",
      keys: ["password"],
      value: "[A-Z]{12}",
    };
    const { masker } = build([
      shape,
      { ...shape, id: "fixed", strategy: "fixed", replacement: "<VALUE-{n}>" },
    ]);
    const texts = [value, `password=${value}`];
    const masked = await masker.mask(texts);
    expect(masked[0]).toMatch(/^[A-Z]{12}$/);
    expect(masked[0]).not.toBe(value);
    expect(masker.restoreValue(masked)).toEqual(texts);
  });

  it("preserves the winning fixed rule's encoded rejection during rematching", async () => {
    const value = "ABCDEFGHIJKL";
    const fixed: Rule = {
      id: "fixed",
      type: "keyed",
      enabled: true,
      strategy: "fixed",
      replacement: "<VALUE-{n}>",
      keys: ["password"],
      value: "[A-Z]{12}",
    };
    const { masker, vault } = build([
      fixed,
      { ...fixed, id: "shape", strategy: "shape" },
    ]);
    await expect(
      masker.mask([base64(value), `password=${value}`]),
    ).rejects.toMatchObject({ code: "BLOCKED" });
    expect(vault.entries()).toEqual([]);
    expect(await masker.mask([`password=${value}`])).toEqual([
      "password=<VALUE-1>",
    ]);
  });
  it("rematches a contextual value even when its first hit is covered by a longer match", async () => {
    const value = "ABCDEFGHIJKL";
    const texts = [`password=${value}`, value];
    const { masker } = build([
      literal("whole", [texts[0]]),
      {
        id: "keyed",
        type: "keyed",
        enabled: true,
        strategy: "opaque",
        keys: ["password"],
        value: "[A-Z]{12}",
      },
    ]);
    const masked = await masker.mask(texts);
    expect(masked.every((text) => !text.includes(value))).toBe(true);
    expect(masker.restoreValue(masked)).toEqual(texts);
  });
  it.each([false, true])(
    "masks earlier bare values and duplicates in one batch: %s",
    async (duplicates) => {
      const value = "ABCDEFGHIJKL";
      const { masker } = build([
        {
          id: "keyed",
          type: "keyed",
          enabled: true,
          strategy: "opaque",
          keys: ["password"],
          value: "[A-Z]{12}",
        },
      ]);
      const texts = duplicates
        ? [value, value, `password=${value}`, value]
        : [value, `password=${value}`];
      const masked = await masker.mask(texts);
      expect(masked.every((text) => !text.includes(value))).toBe(true);
      expect(masker.restoreValue(masked)).toEqual(texts);
    },
  );

  it.each([
    { format: "base64", context: false },
    { format: "base64", context: true },
    { format: "percent", context: false },
    { format: "percent", context: true },
  ])(
    "rematches same-batch $format views with encoded context=$context",
    async ({ format, context }) => {
      const value = "ABCDEFGHIJKL";
      const { masker } = build([
        {
          id: "keyed",
          type: "keyed",
          enabled: true,
          strategy: "opaque",
          keys: ["password"],
          value: "[A-Z]{12}",
        },
      ]);
      const encode = format === "base64" ? base64 : percentEach;
      const keyed = `password=${value}`;
      const texts = context ? [encode(keyed), value] : [encode(value), keyed];
      const masked = await masker.mask(texts);
      const decoded =
        format === "base64"
          ? Buffer.from(masked[0], "base64").toString("utf8")
          : decodeURIComponent(masked[0]);
      expect(decoded.includes(value) || masked[1].includes(value)).toBe(false);
      expect(masker.restoreValue(masked)).toEqual(texts);
    },
  );

  it("uses the discovered fixed strategy for an earlier bare occurrence", async () => {
    const value = "ABCDEFGHIJKL";
    const { masker } = build([
      {
        id: "keyed",
        type: "keyed",
        enabled: true,
        strategy: "fixed",
        replacement: "<VALUE-{n}>",
        keys: ["password"],
        value: "[A-Z]{12}",
      },
    ]);
    const texts = [value, `password=${value}`];
    const masked = await masker.mask(texts);
    expect(masked).toEqual(["<VALUE-1>", "password=<VALUE-1>"]);
    expect(masker.restoreValue(masked)).toEqual(texts);
  });
  it("masks a newly learned value repeated bare within the same request", async () => {
    const { masker } = build([
      {
        id: "keyed",
        type: "keyed",
        enabled: true,
        strategy: "opaque",
        keys: ["password"],
        value: "[A-Z]{12}",
      },
    ]);
    const value = "ABCDEFGHIJKL";
    const masked = await masker.mask([`password=${value}`, value]);
    expect(masked.every((text) => !text.includes(value))).toBe(true);
  });
  it("remains usable after a scanner failure", async () => {
    const { masker, vault } = build([literal("value", ["SYNTHETIC-123"])]);
    vi.spyOn(Scanner.prototype, "scan").mockRejectedValueOnce(
      new ScanError("SCAN_CRASH", "worker exited"),
    );
    await expect(masker.mask(["SYNTHETIC-123"])).rejects.toMatchObject({
      code: "SCAN_CRASH",
    });
    expect(vault.entries()).toEqual([]);
    const [masked] = await masker.mask(["SYNTHETIC-123"]);
    expect(masked.includes("SYNTHETIC-123")).toBe(false);
    expect(vault.restore(masked)).toBe("SYNTHETIC-123");
  });

  it("rolls back a render collision and permits the next mask", async () => {
    const { masker, vault } = build([
      literal("value", ["SECRET-ONE", "SECRET-TWO"], "fixed", "<FAKE-{n}>"),
    ]);
    const occupied = Array.from(
      { length: 64 },
      (_, index) => `<FAKE-${index + 2}>`,
    );
    await expect(
      masker.mask(["SECRET-ONE", "SECRET-TWO", ...occupied]),
    ).rejects.toMatchObject({ code: "VAULT_COLLISION" });
    expect(vault.entries()).toEqual([]);
    expect(await masker.mask(["SECRET-ONE"])).toEqual(["<FAKE-1>"]);
    expect(vault.restore("<FAKE-1>")).toBe("SECRET-ONE");
  });
  it("leaves no partial mappings when a batch reaches the vault cap", async () => {
    const entries: [string, string][] = Array.from(
      { length: 49999 },
      (_, index) => [
        `r${String(index).padStart(5, "0")}`,
        `f${String(index).padStart(5, "0")}`,
      ],
    );
    const vault = new Vault(seeded("cap-atomic"), entries);
    const { masker } = build([regex("cap", "SEC-[A-Z]{12}")], vault);
    await expect(
      masker.mask(["SEC-ABCDEFGHIJKL SEC-MNOPQRSTUVWX"]),
    ).rejects.toMatchObject({ code: "VAULT_FULL" });
    expect(vault.entries().length).toBe(entries.length);
    const [masked] = await masker.mask(["SEC-ABCDEFGHIJKL"]);
    expect(masked.includes("SEC-ABCDEFGHIJKL")).toBe(false);
    expect(vault.entries().length).toBe(entries.length + 1);
  });

  it("masks regex matches with a same-shape fake that the vault restores", async () => {
    const { masker, vault } = build([
      { ...regex("ticket", "\\bTKT-\\d{6}\\b"), strategy: "shape" },
    ]);
    const [masked] = await masker.mask(["see TKT-123456 now"]);
    expect(masked).toMatch(/^see [A-Z]{3}-\d{6} now$/);
    expect(vault.restore(masked)).toBe("see TKT-123456 now");
  });

  it("masks regex matches with an opaque fake of the same length that the vault restores", async () => {
    const { masker, vault } = build([regex("ticket", "\\bTKT-\\d{6}\\b")]);
    const [masked] = await masker.mask(["see TKT-123456 now"]);
    expect(masked).toMatch(/^see [A-Za-z0-9]{10} now$/);
    expect(masked).not.toContain("TKT-123456");
    expect(vault.restore(masked)).toBe("see TKT-123456 now");
  });

  it("masks literal values", async () => {
    const { masker } = build([literal("client", ["Acme-Corp"])]);
    const [masked] = await masker.mask(["for Acme-Corp only"]);
    expect(masked).not.toContain("Acme-Corp");
    expect(masked).toMatch(/^for [A-Za-z0-9]{9} only$/);
    expect(masker.restoreValue(masked)).toBe("for Acme-Corp only");
  });

  it("masks the current value of an env rule's variables", async () => {
    const { masker } = build(
      [
        {
          id: "env-token",
          type: "env",
          enabled: true,
          strategy: "opaque",
          vars: ["DEMO_TOKEN"],
        },
      ],
      undefined,
      { DEMO_TOKEN: "tok-live-98765" },
    );
    const [masked] = await masker.mask(["sent tok-live-98765"]);
    expect(masked).not.toContain("tok-live-98765");
  });

  it("masks nothing for env rules whose variables are unset or empty", async () => {
    const { masker } = build(
      [
        {
          id: "env-token",
          type: "env",
          enabled: true,
          strategy: "opaque",
          vars: ["DEMO_TOKEN", "EMPTY"],
        },
      ],
      undefined,
      { EMPTY: "" },
    );
    expect(await masker.mask(["nothing here"])).toEqual(["nothing here"]);
  });

  it("masks the values of the variables whose names match an env rule's namePattern", async () => {
    const { masker } = build(
      [
        {
          id: "env-names",
          type: "env",
          enabled: true,
          strategy: "opaque",
          namePattern: "TOKEN",
        },
      ],
      undefined,
      { EXAMPLE_API_TOKEN: "example-live-98765", HOME_DIR: "home-live-98765" },
    );
    const [masked] = await masker.mask([
      "sent example-live-98765 and home-live-98765",
    ]);
    expect(masked).not.toContain("example-live-98765");
    expect(masked).toContain("home-live-98765");
  });

  it("masks the values of secret-named variables through the default rules", async () => {
    const env = {
      EXAMPLE_API_TOKEN: "example-live-98765",
      AWS_SECRET_ACCESS_KEY: "aws-live-43210",
      db_password: "db-live-24680",
      PGPASSWORD: "pg-live-13570",
      GPG_PASSPHRASE: "gpg-live-97531",
      GOOGLE_CREDENTIALS: "gcp-live-86420",
      OPENAI_APIKEY: "oai-live-75319",
      AZURE_DEVOPS_EXT_PAT: "ado-live-64208",
      MYSQL_PWD: "sql-live-53197",
    };
    const { masker } = build(DEFAULT_RULES, undefined, env);
    const text =
      "example-live-98765 aws-live-43210 db-live-24680 pg-live-13570 gpg-live-97531 gcp-live-86420 oai-live-75319 ado-live-64208 sql-live-53197";
    const [masked] = await masker.mask([text]);
    expect(masked).not.toMatch(/-live-/);
    expect(masker.restoreValue(masked)).toBe(text);
  });

  it("keeps the values of variables whose names only contain a secret word inside another word", async () => {
    const env = {
      KEYBOARD_LAYOUT: "kbd-live-13579",
      MONKEY_PATH: "mon-live-11223",
      GOPATH: "gop-live-99887",
      OLDPWD_NOTE: "old-live-77665",
    };
    const { masker } = build(DEFAULT_RULES, undefined, env);
    const text = "kbd-live-13579 mon-live-11223 gop-live-99887 old-live-77665";
    expect(await masker.mask([text])).toEqual([text]);
  });

  it("keeps the short and all-digit values of secret-named variables", async () => {
    const env = {
      API_TOKEN: "true",
      SECRET_PIN: "1234567",
      DB_PASSWORD: "12345678",
    };
    const { masker } = build(DEFAULT_RULES, undefined, env);
    const text = "true 1234567 12345678";
    expect(await masker.mask([text])).toEqual([text]);
  });

  it("keeps the host names of the variables that locationNamePattern names", async () => {
    const env = {
      SITE_TOKEN: "acme.example",
      AUTH_URL: "https://other.example",
    };
    const rule: Rule = {
      id: "site",
      type: "env",
      enabled: true,
      strategy: "opaque",
      namePattern: "TOKEN|URL",
      locationNamePattern: "_TOKEN$",
    };
    const { masker } = build([rule], undefined, env);
    const [masked] = await masker.mask([`${env.SITE_TOKEN} ${env.AUTH_URL}`]);
    expect(masked).toContain("acme.example");
    expect(masked).not.toContain("other.example");
  });

  it("masks a dotted passphrase and a webhook URL of secret-named variables", async () => {
    const env = {
      GPG_PASSPHRASE: "correct.horse.battery.staple",
      ZAPIER_WEBHOOK_SECRET:
        "https://hooks.zapier.com/hooks/catch/1234567/abcdef9/",
    };
    const { masker } = build(DEFAULT_RULES, undefined, env);
    const [masked] = await masker.mask([
      `${env.GPG_PASSPHRASE} ${env.ZAPIER_WEBHOOK_SECRET}`,
    ]);
    expect(masked).not.toContain("correct.horse");
    expect(masked).not.toContain("abcdef9");
  });

  it("keeps the URLs without credentials and the host names of secret-named variables", async () => {
    const env = {
      AUTH_URL: "http://localhost:8080/realms/master",
      VITE_FIREBASE_AUTH_DOMAIN: "demo-app.firebaseapp.com",
    };
    const { masker } = build(DEFAULT_RULES, undefined, env);
    const text = `listening on localhost:3000, ${env.AUTH_URL}, ${env.VITE_FIREBASE_AUTH_DOMAIN}`;
    expect(await masker.mask([text])).toEqual([text]);
  });

  it("masks keyed values and keeps the key", async () => {
    const { masker } = build([
      {
        id: "keyed-id",
        type: "keyed",
        enabled: true,
        strategy: "opaque",
        keys: ["clientId"],
        value: "[A-Za-z0-9]{4,}",
      },
    ]);
    const [masked] = await masker.mask(['{"clientId": "ab12cd"}']);
    expect(masked).toMatch(/^\{"clientId": "[A-Za-z0-9]{6}"\}$/);
    expect(masked).not.toContain("ab12cd");
    expect(masker.restoreValue(masked)).toBe('{"clientId": "ab12cd"}');
  });

  it.each(["userId: 4", '"userId": 42', "userId: a1b"])(
    "leaves a keyed ID under 4 characters: %s",
    async (text) => {
      const { masker } = build(DEFAULT_RULES);
      expect(await masker.mask([text])).toEqual([text]);
    },
  );

  it("skips disabled rules", async () => {
    const { masker } = build([
      { ...literal("off", ["Acme-Corp"]), enabled: false },
    ]);
    expect(await masker.mask(["Acme-Corp"])).toEqual(["Acme-Corp"]);
  });

  it("masks GitHub tokens with the default rules", async () => {
    const random = seeded("default");
    const token = "ghp" + "_" + word(random, 36);
    const { masker, vault } = build(DEFAULT_RULES);
    const [masked] = await masker.mask([`token ${token} end`]);
    expect(masked).not.toContain(token);
    expect(vault.restore(masked)).toBe(`token ${token} end`);
  });

  it("masks account ids with the default rules and keeps code words", async () => {
    const { masker, vault } = build(DEFAULT_RULES);
    const text =
      "--user ABC1234567_acme J0123456 ISO27001 SHA256 v1234567 ABC1234567890";
    const [masked] = await masker.mask([text]);
    expect(masked).not.toMatch(/ABC1234567_acme|J0123456/);
    expect(masked).toContain(" ISO27001 SHA256 v1234567 ABC1234567890");
    expect(vault.restore(masked)).toBe(text);
  });
});

describe("Masker spans", () => {
  it("masks the longest of overlapping matches and drops the rest", async () => {
    const { masker, vault } = build([
      literal("short", ["Project-Alpha"]),
      literal("long", ["Project-Alpha-Prod"]),
    ]);
    const text = "x Project-Alpha-Prod y";
    const [masked] = await masker.mask([text]);
    expect(masked).toMatch(/^x [A-Za-z0-9]{18} y$/);
    expect(vault.restore(masked)).toBe(text);
  });

  it("masks and restores the tail of a match that ends past an overlapping earlier match", async () => {
    // Built at run time, so no token literal is in the file.
    const jwt = [
      "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9",
      "eyJzdWIiOiJvdmVybGFwLXVzZXIiLCJyb2xlIjoiYWRtaW4ifQ",
      ["Qm9yZWFs", "TGFudGVybjk3", "WHlsb3Bob25l"].join(""),
    ].join(".");
    const { masker, vault } = build([
      regex("project-bearer", "Bearer eyJ[A-Za-z0-9_-]*"),
      ...DEFAULT_RULES,
    ]);
    const text = `Authorization: Bearer ${jwt} ok`;
    const [masked] = await masker.mask([text]);
    for (const segment of jwt.split(".")) expect(masked).not.toContain(segment);
    expect(vault.restore(masked)).toBe(text);
  });

  it("keeps a mask rule when its copy extends over an overlapping match", async () => {
    const value = "Zq7m-W2pLx9";
    const { masker, vault } = build([
      {
        id: "pin",
        type: "regex",
        enabled: true,
        strategy: "mask",
        pattern: "pin=([A-Za-z0-9-]+)",
        flags: "",
        group: 1,
        replacement: "[PIN]",
      },
      regex("tail", "W2pLx9\\.[A-Za-z]+"),
    ]);
    const [masked] = await masker.mask([
      `pin=${value} then ${value}.tailpart end`,
    ]);
    expect(masked).toBe("pin=[PIN] then [PIN] end");
    expect(vault.restore(masked)).not.toContain(value);
  });

  it("never masks part of a token", async () => {
    const { masker } = build([regex("digits", "\\d{3}")]);
    expect(await masker.mask(["x12345y"])).toEqual(["x12345y"]);
  });

  it("masks only the password of a URL whose host is an email domain", async () => {
    const text =
      "database:\n  url: postgres://billing:Qz0GsfDRB3As-7x@db.internal:5432/billing";
    const { masker, vault } = build(DEFAULT_RULES);
    const [masked] = await masker.mask([text]);
    expect(masked).toMatch(
      /^database:\n {2}url: postgres:\/\/billing:[A-Za-z0-9]{15}@db\.internal:5432\/billing$/,
    );
    expect(vault.entries().map(([real]) => real)).toEqual(["Qz0GsfDRB3As-7x"]);
    expect(vault.restore(masked)).toBe(text);
  });

  it("learns a URL password with an email-shaped host, for a later bare echo", async () => {
    const password = "Qm7vXc2LpT9wRz4K";
    const { masker, vault } = build(DEFAULT_RULES);
    const [url] = await masker.mask([
      `postgres://pmsuser:${password}@db.example.test:5432/app`,
    ]);
    expect(url).not.toContain(password);
    const [echo] = await masker.mask([`echo ${password}`]);
    expect(echo).not.toContain(password);
    expect(vault.restore(echo)).toBe(`echo ${password}`);
  });

  it("masks only the password of a URL with an email-shaped host", async () => {
    const { masker } = build(DEFAULT_RULES);
    const [url] = await masker.mask([
      "postgres://pmsuser:Qm7vXc2LpT9wRz4K@db.example.test:5432/app",
    ]);
    expect(url).toMatch(
      /^postgres:\/\/pmsuser:[A-Za-z0-9]{16}@db\.example\.test:5432\/app$/,
    );
  });

  it("gives a shape real that heads a known shape real the head of its fake", async () => {
    const { masker } = build([
      literal("local-identity", ["jdupont@acme-corp.com", "jdupont"], "shape"),
    ]);
    const [email] = await masker.mask(["jdupont@acme-corp.com"]);
    const [path] = await masker.mask(["/Users/jdupont/app"]);
    expect(path).toBe(`/Users/${email.slice(0, 7)}/app`);
    expect(masker.restoreValue(path)).toBe("/Users/jdupont/app");
  });

  it("gives a short letters-only shape real a fake that is no word, even as the head of a known fake", async () => {
    const { masker } = build([
      literal("local-identity", ["bob@acme-corp.com", "bob"], "shape"),
    ]);
    await masker.mask(["bob@acme-corp.com"]);
    const [path] = await masker.mask(["/Users/bob/app"]);
    expect(path).toMatch(/^\/Users\/[A-Za-z0-9]{3}\/app$/);
    expect(path).not.toMatch(/^\/Users\/[A-Za-z]{3}\//);
    expect(masker.restoreValue(path)).toBe("/Users/bob/app");
  });

  it("masks an email in a query string right after a port", async () => {
    const { masker } = build(DEFAULT_RULES);
    const [masked] = await masker.mask([
      "https://db.internal:8443?email=ana@example.com",
    ]);
    expect(masked).not.toContain("ana@example.com");
    expect(masked).toMatch(
      /^https:\/\/db\.internal:8443\?email=[a-z]{3}@[a-z]{7}\.[a-z]{3}$/,
    );
  });

  it("does not learn a span that only splits a token", async () => {
    const { masker, vault } = build([regex("digits", "\\d{10}")]);
    expect(await masker.mask(["x1234567890y"])).toEqual(["x1234567890y"]);
    expect(vault.entries()).toEqual([]);
  });

  it("learns a URL password whose host is not an email domain", async () => {
    const password = "Qm7vXc2LpT9wRz4K";
    const { masker } = build(DEFAULT_RULES);
    await masker.mask([`postgres://pmsuser:${password}@localhost:5432/app`]);
    const [echo] = await masker.mask([`echo ${password}`]);
    expect(echo).not.toContain(password);
  });

  it("learns a contained password that differs from the URL around it", async () => {
    const password = "Qm7vXc2LpT9wRz4K";
    const { masker, vault } = build([
      regex("url", "postgres://\\S+"),
      literal("password", [password], "fixed", "PW-{n}"),
    ]);
    const [url] = await masker.mask([
      `postgres://pmsuser:${password}@db.example.test/app`,
    ]);
    expect(url).not.toContain(password);
    const [echo] = await masker.mask([`echo ${password}`]);
    expect(echo).not.toContain(password);
    expect(vault.restore(echo)).toBe(`echo ${password}`);
  });

  it("blocks before learning a lost overlap in the same batch", async () => {
    const vault = new Vault(seeded("block-overlap"));
    const { masker } = build(
      [
        regex("token", "SEC-[A-Za-z0-9]{12}"),
        literal("gate", ["abcdefGHIJKL"], "block"),
        literal("lost", ["SEC-abcdefGHIJKL"], "fixed", "ID-{n}"),
      ],
      vault,
    );
    await expect(masker.mask(["x SEC-abcdefGHIJKL y"])).rejects.toMatchObject({
      code: "BLOCKED",
    });
    expect(vault.entries()).toEqual([]);
  });

  it("re-hides learned values of 8 characters or more when no rule fires", async () => {
    const vault = new Vault(seeded("learned"), [
      ["Acme-Corp-42", "Qzvbm-Lpwt-42"],
    ]);
    const { masker } = build([], vault);
    expect(await masker.mask(["ping Acme-Corp-42 today"])).toEqual([
      "ping Qzvbm-Lpwt-42 today",
    ]);
  });

  it("does not re-hide learned values shorter than 8 characters", async () => {
    const vault = new Vault(seeded("short"), [["Acme-42", "Qzvbm-42"]]);
    const { masker } = build([], vault);
    expect(await masker.mask(["ping Acme-42 today"])).toEqual([
      "ping Acme-42 today",
    ]);
  });

  it("gives the same fake to the same real in later calls", async () => {
    const { masker } = build([regex("ticket", "\\bTKT-\\d{6}\\b")]);
    const [first] = await masker.mask(["a TKT-123456"]);
    const [second] = await masker.mask(["b TKT-123456"]);
    expect(second?.slice(2)).toBe(first?.slice(2));
  });
});

describe("Masker strategies", () => {
  it("numbers distinct fixed values and restores them", async () => {
    const { masker, vault } = build([
      literal("ids", ["Client-One", "Client-Two"], "fixed", "ID-{n}"),
    ]);
    const text = "Client-One and Client-Two and Client-One";
    const [masked] = await masker.mask([text]);
    expect(masked).toBe("ID-1 and ID-2 and ID-1");
    expect(vault.restore(masked)).toBe(text);
  });

  it("gives the variants of one name one fixed number in their own shape", async () => {
    const { masker } = build([
      {
        id: "client",
        type: "regex",
        enabled: true,
        strategy: "fixed",
        replacement: "Client{n}",
        pattern: "(?<!\\w)\\w*(?<name>acme[ _.-]?corp)\\w*",
        flags: "i",
        group: 0,
      },
    ]);
    const text =
      "AcmeCorp, ACMECORP, acmecorp, Acme Corp, AcmeCorpTheme, @acmecorpcode/ui";
    const [masked] = await masker.mask([text]);
    expect(masked).toBe(
      "Client1, CLIENT1, client1, Client 1, Client1Theme, @client1code/ui",
    );
    expect(masker.restoreValue(masked)).toBe(text);
    await expect(masker.assertNoHiddenReal([masked])).resolves.toBeUndefined();
  });

  it("scans a long word in linear time with the documented name pattern", async () => {
    const doc = readFileSync("docs/CONFIGURATION.md", "utf8");
    const pattern =
      /"id": "client",\n\s+"type": "regex",\n\s+"pattern": "(.+)",/.exec(
        doc,
      )?.[1];
    expect(pattern).toBeDefined();
    const { masker } = build([
      {
        id: "client",
        type: "regex",
        enabled: true,
        strategy: "fixed",
        replacement: "Client{n}",
        pattern: JSON.parse(`"${pattern}"`),
        flags: "i",
        group: 0,
      },
    ]);
    const [masked] = await masker.mask([`${"a".repeat(100_000)} AcmeCorp`]);
    expect(masked.endsWith(" Client1")).toBe(true);
  });

  it("keeps no secret of another rule in the rest of a fixed fake", async () => {
    const { masker } = build([
      {
        id: "client",
        type: "regex",
        enabled: true,
        strategy: "fixed",
        replacement: "Client{n}",
        pattern: "(?<!\\w)\\w*(?<name>acme[ _.-]?corp)\\w*",
        flags: "i",
        group: 0,
      },
      literal("password", ["Zq7Wm3Kp9Xv2"]),
    ]);
    const text = "acmecorp_Zq7Wm3Kp9Xv2 Zq7Wm3Kp9Xv2_acmecorp";
    const [masked] = await masker.mask([text]);
    expect(masked).not.toContain("Zq7Wm3Kp9Xv2");
    expect(masker.restoreValue(masked)).toBe(text);
  });

  describe("a secret learned beside a fixed fake that holds it in its rest", () => {
    const rules = (replacement = "Client{n}"): Rule[] => [
      {
        id: "client",
        type: "regex",
        enabled: true,
        strategy: "fixed",
        replacement,
        pattern: "(?<!\\w)\\w*(?<name>acme[ _.-]?corp)\\w*",
        flags: "i",
        group: 0,
      },
      {
        id: "password",
        type: "keyed",
        enabled: true,
        strategy: "opaque",
        keys: ["password"],
        value: "[A-Za-z0-9_]{10,12}",
      },
    ];
    const glued = "deploy acmecorp_Zqw_Mkp_Xvb now";
    const learned = "password=Zqw_Mkp_Xvb";

    it("is not sent when it has only digits", async () => {
      const { masker } = build(rules());
      const text = "deploy acmecorp_98765432109 now";
      const masked = await masker.mask([text, "password=98765432109"]);
      expect(masked[0]).not.toContain("98765432109");
      expect(masker.restoreValue(masked[0])).toBe(text);
    });

    it("is not sent when the rest holds the template word before it", async () => {
      const { masker } = build(rules("Company{n}"));
      const text = "see company2024Secret_acmecorp";
      const masked = await masker.mask([text, "password=2024Secret"]);
      expect(masked[0]).not.toContain("2024Secret");
      expect(masker.restoreValue(masked[0])).toBe(text);
    });

    it("is reported in the same payload", async () => {
      const { masker } = build(rules());
      const masked = await masker.mask([glued, learned]);
      await expect(masker.assertNoHiddenReal(masked, false)).rejects.toThrow(
        "HIDDEN_REAL",
      );
    });

    it("is reported in a later payload", async () => {
      const { masker } = build(rules());
      await masker.mask([glued]);
      const masked = await masker.mask([glued, learned]);
      await expect(masker.assertNoHiddenReal(masked, false)).rejects.toThrow(
        "HIDDEN_REAL",
      );
    });
  });

  it("replaces the whole variant whose rest starts with a digit", async () => {
    const { masker } = build([
      {
        id: "client",
        type: "regex",
        enabled: true,
        strategy: "fixed",
        replacement: "Client{n}",
        pattern: "(?<!\\w)\\w*(?<name>acme[ _.-]?corp)\\w*",
        flags: "i",
        group: 0,
      },
    ]);
    const text = "acmecorp2x AcmeCorp ACMECORP2";
    const [masked] = await masker.mask([text]);
    expect(masked).toBe("client1 Client2 CLIENT3");
    expect(masker.restoreValue(masked)).toBe(text);
  });

  it("keeps no match of another rule in the rest of a fixed fake", async () => {
    const { masker } = build([
      {
        id: "client",
        type: "regex",
        enabled: true,
        strategy: "fixed",
        replacement: "Client{n}",
        pattern: "(?<!\\w)\\w*(?<name>acme[ _.-]?corp)\\w*",
        flags: "i",
        group: 0,
      },
      regex("aws", "AKIA[0-9A-Z]{16}"),
    ]);
    const text = "acmecorp_AKIAQ7W3K9X2M4P8R6T1";
    const [masked] = await masker.mask([text]);
    expect(masked).not.toContain("Q7W3K9X2M4P8R6T1");
    expect(masker.restoreValue(masked)).toBe(text);
  });

  it("keeps no real text in a fixed fake of a pattern without a name group", async () => {
    const { masker } = build([
      {
        ...regex("employee", "EMP\\d+"),
        strategy: "fixed",
        replacement: "EMP_{n}",
      },
    ]);
    expect(await masker.mask(["id EMP48213957"])).toEqual(["id EMP_1"]);
  });

  it("writes [MASKED] for mask strategy and keeps nothing in the vault", async () => {
    const { masker, vault } = build([literal("gone", ["Hunter-Two"], "mask")]);
    expect(await masker.mask(["has Hunter-Two"])).toEqual(["has [MASKED]"]);
    expect(vault.entries()).toEqual([]);
  });

  it("keeps a mask winner's policy when a fixed rule also matches its real", async () => {
    const { masker, vault } = build([
      literal("gone", ["Hunter-Two"], "mask"),
      literal("lost", ["Hunter-Two"], "fixed", "<LOST-{n}>"),
    ]);
    expect(await masker.mask(["has Hunter-Two"])).toEqual(["has [MASKED]"]);
    expect(vault.entries()).toEqual([]);
    expect(await masker.mask(["bare Hunter-Two"])).toEqual(["bare [MASKED]"]);
  });

  it("keeps a mask winner's policy for its real when a lost overlap repeats it in another text", async () => {
    const { masker, vault } = build([
      literal("gone", ["Hunter-Two"], "mask"),
      literal("lost", ["Hunter-Two"], "fixed", "<LOST-{n}>"),
      regex("pair", "AB-\\S+"),
    ]);
    const [first] = await masker.mask(["has Hunter-Two", "AB-Hunter-Two"]);
    expect(first).toBe("has [MASKED]");
    expect(vault.entries().map(([real]) => real)).toEqual(["AB-Hunter-Two"]);
  });

  it("writes the configured replacement for mask strategy", async () => {
    const { masker } = build([
      literal("gone", ["Hunter-Two"], "mask", "<hidden>"),
    ]);
    expect(await masker.mask(["has Hunter-Two"])).toEqual(["has <hidden>"]);
  });

  it("rejects the whole batch when a block rule fires", async () => {
    const { masker } = build([literal("gate", ["Hunter-Two"], "block")]);
    await expect(
      masker.mask(["clean", "has Hunter-Two"]),
    ).rejects.toMatchObject({
      code: "BLOCKED",
    });
  });

  it("rejects the batch when a block rule matches inside a longer match", async () => {
    const { masker } = build([
      regex("token", "SEC-[A-Za-z0-9]{12}"),
      literal("gate", ["abcdefGHIJKL"], "block"),
    ]);
    await expect(masker.mask(["x SEC-abcdefGHIJKL y"])).rejects.toMatchObject({
      code: "BLOCKED",
    });
  });

  it("leaves the vault unchanged when a block rule fires", async () => {
    const vault = new Vault(seeded("blocked"));
    const { masker } = build(
      [
        regex("ticket", "\\bTKT-\\d{6}\\b"),
        literal("gate", ["Hunter-Two"], "block"),
      ],
      vault,
    );
    await expect(
      masker.mask(["TKT-123456", "has Hunter-Two"]),
    ).rejects.toMatchObject({ code: "BLOCKED" });
    expect(vault.entries()).toEqual([]);
  });

  it("rejects the batch when the scanner fails", async () => {
    const { masker } = build([regex("broken", "(")]);
    await expect(masker.mask(["anything"])).rejects.toMatchObject({
      code: "SCAN_PATTERN",
    });
  });
});

describe("Masker.maskPayload", () => {
  it("masks string values, keeps keys and non-string values", async () => {
    const { masker, vault } = build([regex("ticket", "\\bTKT-\\d{6}\\b")]);
    const payload = {
      "TKT-123456": "token TKT-123456",
      max_tokens: 4096,
      messages: [{ role: "user", content: ["TKT-123456"] }],
    };
    const masked = await masker.maskPayload(payload);
    expect(masked).toEqual({
      "TKT-123456": expect.any(String),
      max_tokens: 4096,
      messages: [{ role: "user", content: [expect.any(String)] }],
    });
    expect(JSON.stringify(masked)).not.toContain("token TKT-123456");
    expect(vault.restore(JSON.stringify(masked))).toBe(JSON.stringify(payload));
  });

  it("does not let a fake take the place of text in another input of the same call", async () => {
    const first = build(
      [regex("ticket", "\\bTKT-\\d{6}\\b")],
      new Vault(seeded("call")),
    );
    const [fake] = await first.masker.mask(["TKT-123456"]);
    const second = build(
      [regex("ticket", "\\bTKT-\\d{6}\\b")],
      new Vault(seeded("call")),
    );
    const [masked, other] = await second.masker.mask([
      "TKT-123456",
      String(fake),
    ]);
    expect(second.vault.restore(String(other))).toBe(fake);
    expect(second.vault.restore(String(masked))).toBe("TKT-123456");
  });

  it("rejects fixed rules without {n} at construction", () => {
    expect(() =>
      build([literal("fixed", ["Client-One"], "fixed", "ID")]),
    ).toThrow(/needs \{n\}/);
  });

  it("rejects cycles and non-JSON values with PAYLOAD_SHAPE", async () => {
    const { masker } = build([]);
    const cycle: Record<string, unknown> = {};
    cycle.self = cycle;
    await expect(masker.maskPayload(cycle)).rejects.toMatchObject({
      code: "PAYLOAD_SHAPE",
    });
    await expect(masker.maskPayload({ fn: () => 1 })).rejects.toMatchObject({
      code: "PAYLOAD_SHAPE",
    });
  });

  it("rejects payloads over 8 MiB with PAYLOAD_SIZE", async () => {
    const { masker } = build([]);
    await expect(
      masker.maskPayload({ text: "x".repeat(8 * 1024 * 1024) }),
    ).rejects.toMatchObject({
      code: "PAYLOAD_SIZE",
    });
  });

  it("masks every field when the format names none", async () => {
    const { masker } = build([literal("ticket", ["TKT-123456"])]);
    const masked = await masker.maskPayload({
      signature: "TKT-123456",
      encrypted_content: "TKT-123456",
      id: "toolu_01 TKT-123456",
    });
    expect(JSON.stringify(masked)).not.toContain("TKT-123456");
  });

  it("keeps a field the format names, with its children, out of the size limit", async () => {
    const big = "TKT-123456 ".repeat(1024 * 1024);
    const format: PayloadFormat = { opaque: (key) => key === "kept" };
    const { masker } = build(
      [literal("ticket", ["TKT-123456"])],
      undefined,
      {},
      format,
    );
    const masked = await masker.maskPayload({
      kept: { text: big, bytes: new Uint8Array([1]) },
      other: "TKT-123456",
    });
    expect(masked).toEqual({
      kept: { text: big, bytes: new Uint8Array([1]) },
      other: expect.not.stringContaining("TKT-123456"),
    });
  });
});

describe("Masker.restoreValue", () => {
  it("restores strings in nested values and keeps other values", () => {
    const { masker, vault } = build([]);
    const fake = vault.fakeFor("TKT-123456", "");
    expect(
      masker.restoreValue({ id: fake, list: [fake, true], nested: { n: 1 } }),
    ).toEqual({
      id: "TKT-123456",
      list: ["TKT-123456", true],
      nested: { n: 1 },
    });
  });

  it("restores a digits-only fake that is a number to the real number", () => {
    const { masker, vault } = build([]);
    const fake = vault.shapeFor("48213", "");
    expect(masker.restoreValue(Number(fake))).toBe(48213);
  });
});

describe("Masker encoded runs", () => {
  it("masks a Secret base64 field and restores the original base64 exactly", async () => {
    const password = word(seeded("k8s"), 18);
    const manifest = [
      "apiVersion: v1",
      "kind: Secret",
      "data:",
      `  password: ${base64(password)}`,
    ].join("\n");
    const { masker } = build([literal("password", [password])]);
    const [masked] = await masker.mask([manifest]);
    const run = masked.split("\n")[3]?.slice("  password: ".length) ?? "";
    expect(run).toHaveLength(base64(password).length);
    const fake = Buffer.from(run, "base64").toString();
    expect(fake).toMatch(/^[A-Za-z0-9]{18}$/);
    expect(fake).not.toBe(password);
    expect(masked).not.toContain(password);
    expect(masker.restoreValue(masked)).toBe(manifest);
  });

  it("masks the password inside a Basic authorization header", async () => {
    const random = seeded("basic");
    const user = word(random, 6);
    const password = word(random, 15);
    const header = `Authorization: Basic ${base64(`${user}:${password}`)}`;
    const { masker } = build([literal("password", [password])]);
    const [masked] = await masker.mask([header]);
    expect(masked).toHaveLength(header.length);
    expect(masked).not.toContain(base64(`${user}:${password}`));
    expect(masker.restoreValue(masked)).toBe(header);
  });

  it("masks a URL-encoded password in a query string and keeps the escapes", async () => {
    const random = seeded("query");
    const password = `${word(random, 5)}@${word(random, 5)}:x`;
    const url = `https://db.example.test/connect?user=ops&password=${encodeURIComponent(password)}&sslmode=require`;
    const { masker } = build([literal("password", [password])]);
    const [masked] = await masker.mask([url]);
    expect(masked).toHaveLength(url.length);
    expect(masked).not.toContain(encodeURIComponent(password));
    expect(masker.restoreValue(masked)).toBe(url);
  });

  it("masks base64 wrapped at 76 columns and keeps the line layout", async () => {
    const password = word(seeded("wrap"), 20);
    const wrapped = wrap(base64(`db_password=${password} `.repeat(6)), 76);
    const input = `config:\n${wrapped}\nend`;
    const { masker } = build([literal("password", [password])]);
    const [masked] = await masker.mask([input]);
    expect(masked.split("\n").map((line) => line.length)).toEqual(
      input.split("\n").map((line) => line.length),
    );
    const decoded = Buffer.from(
      masked.split("\n").slice(1, -1).join(""),
      "base64",
    );
    expect(decoded.toString()).not.toContain(password);
    expect(masker.restoreValue(masked)).toBe(input);
  });

  it("drops an outer span that overlaps a view with inner spans", async () => {
    const password = word(seeded("view-wins"), 12);
    const run = base64(password);
    const text = `x ${run} y`;
    const { masker } = build([
      literal("run", [run]),
      literal("password", [password]),
    ]);
    const [masked] = await masker.mask([text]);
    expect(Buffer.from(masked.slice(2, -2), "base64").toString()).toMatch(
      /^[A-Za-z0-9]{12}$/,
    );
    expect(masker.restoreValue(masked)).toBe(text);
  });

  it("keeps an outer span that covers a view without inner spans", async () => {
    const run = base64(word(seeded("outer"), 12));
    const text = `x ${run} y`;
    const { masker } = build([literal("run", [run])]);
    const [masked] = await masker.mask([text]);
    expect(masked).toHaveLength(text.length);
    expect(masked).not.toContain(run);
  });

  it("decodes one level only", async () => {
    const password = word(seeded("level"), 12);
    const text = `x ${base64(base64(password))} y`;
    const { masker } = build([literal("password", [password])]);
    expect(await masker.mask([text])).toEqual([text]);
  });

  it("blocks when a block rule matches inside an encoded run", async () => {
    const password = word(seeded("gate"), 12);
    const { masker } = build([literal("gate", [password], "block")]);
    await expect(
      masker.mask([`x ${base64(password)} y`]),
    ).rejects.toMatchObject({ code: "BLOCKED" });
  });

  it("blocks a raw block match that overlaps an encoded run", async () => {
    const password = word(seeded("raw-gate"), 12);
    const run = base64(password);
    const { masker } = build([
      literal("gate", [run], "block"),
      literal("password", [password]),
    ]);
    await expect(masker.mask([run])).rejects.toMatchObject({ code: "BLOCKED" });
  });

  it("blocks a mask rule that matches inside an encoded run, naming the rule", async () => {
    const password = word(seeded("reencode"), 12);
    const { masker } = build([literal("hide", [password], "mask")]);
    const rejected = masker.mask([`x ${base64(password)} y`]);
    await expect(rejected).rejects.toMatchObject({ code: "BLOCKED" });
    await expect(rejected).rejects.toThrow(/rule hide/);
    await expect(rejected).rejects.not.toThrow(password);
  });

  it("leaves an encoded run as written when its restored text changes length", () => {
    const vault = new Vault(seeded("length"), [["Client-One", "ID-1"]]);
    const { masker } = build([], vault);
    expect(masker.restoreValue(base64("ID-1"))).toBe(base64("ID-1"));
  });

  it("restores a fixed fake that also reads as an encoded run", async () => {
    const { masker } = build([
      literal("secret", ["Hunter2Secret"], "fixed", "QUJDREVGR0hJSkt{n}"),
    ]);
    const text = "token Hunter2Secret";
    const [masked] = await masker.mask([text]);
    expect(masked).toBe("token QUJDREVGR0hJSkt1");
    expect(masker.restoreValue(masked)).toBe(text);
  });

  it("restores a wrapped fixed fake whose inner text reads as an encoded run", async () => {
    const { masker } = build([
      literal("secret", ["Hunter2Secret"], "fixed", "<QUJDREVGR0hJSkt{n}>"),
    ]);
    const text = "token Hunter2Secret";
    const [masked] = await masker.mask([text]);
    expect(masked).toBe("token <QUJDREVGR0hJSkt1>");
    expect(masker.restoreValue(masked)).toBe(text);
  });

  it("fails closed when a learned fake of another length matches inside an encoded run", async () => {
    const vault = new Vault(seeded("learned-length"), [["Client-One", "ID-1"]]);
    const { masker } = build([], vault);
    await expect(
      masker.mask([percentEach("Client-One")]),
    ).rejects.toMatchObject({ code: "BLOCKED" });
  });

  it("masks a percent-encoded learned value whose fake has the same length", async () => {
    const vault = new Vault(seeded("learned-same"), [
      ["Client-One", "Client-Two"],
    ]);
    const { masker } = build([], vault);
    const text = `q=${percentEach("Client-One")}&x=1`;
    const [masked] = await masker.mask([text]);
    expect(decodeURIComponent(masked.slice(2, -4))).toBe("Client-Two");
    expect(masker.restoreValue(masked)).toBe(text);
  });

  it("masks a percent-encoded email, whose run holds the fakes of its user and domain", async () => {
    const { masker } = build(DEFAULT_RULES);
    const text = "u=ana.lopez%40example.com";
    const [masked] = await masker.mask([text]);
    expect(masked).not.toContain("ana.lopez");
    expect(masker.restoreValue(masked)).toBe(text);
  });
});

/** Fixed seed, so a CI failure replays with the same payloads. */
const PROPERTY_SEED = 20240501;
/** The number of seeded payloads each property checks. */
const PROPERTY_RUNS = 1000;
/** Each run scans with a fresh scanner, so 1000 runs need far more than the default 5 s. */
const PROPERTY_TIMEOUT_MS = 300000;
/** Secret token: a fixed prefix plus 12 alphanumerics. */
const SECRET_PATTERN = "SEC-[A-Za-z0-9]{12}";

/** Every byte of `text` as a percent escape. */
const percentEach = (text: string): string =>
  [...Buffer.from(text)]
    .map((byte) => `%${byte.toString(16).padStart(2, "0")}`)
    .join("");

describe("Masker property", () => {
  it("rematches new contextual values throughout an ordered payload batch", async () => {
    const worker = new Scanner(2000);
    onTestFinished(() => worker.close());
    await fc.assert(
      fc.asyncProperty(
        fc.stringMatching(/^[A-Z]{12}$/),
        fc.boolean(),
        fc.integer({ min: 1, max: 4 }),
        async (value, reverse, count) => {
          const masker = new Masker(
            [
              {
                id: "context",
                type: "regex",
                enabled: true,
                strategy: "opaque",
                pattern: "password=([A-Z]{12})",
                flags: "",
                group: 1,
              },
            ],
            worker,
            new Vault(seeded(value)),
            {},
            NO_FORMAT,
          );
          const texts = [
            ...Array.from({ length: count }, () => value),
            `password=${value}`,
          ];
          if (reverse) texts.reverse();
          const masked = await masker.maskPayload({ texts });
          expect(JSON.stringify(masked).includes(value)).toBe(false);
          expect(masker.restoreValue(masked)).toEqual({ texts });
        },
      ),
      { seed: 741529, numRuns: 25 },
    );
  });
  it(
    "restores any mixed payload exactly and leaves no vault real in the masked text",
    async () => {
      const secret = fc
        .stringMatching(/^[A-Za-z0-9]{12}$/)
        .map((token) => `SEC-${token}`);
      const segment = fc.oneof(
        fc.stringMatching(/^[a-z0-9]{1,12}$/),
        secret,
        secret.map(base64),
        secret.map(percentEach),
      );
      const payload = fc.array(segment, { minLength: 1, maxLength: 6 });
      const scanner = new Scanner(2000);
      onTestFinished(() => scanner.close());
      await fc.assert(
        fc.asyncProperty(payload, async (segments) => {
          const text = segments.join(" ");
          const vault = new Vault(seeded(text));
          const masker = new Masker(
            [regex("secret", SECRET_PATTERN)],
            scanner,
            vault,
            {},
            NO_FORMAT,
          );
          const [masked] = await masker.mask([text]);
          for (const [real] of vault.entries())
            expect(masked).not.toContain(real);
          expect(masker.restoreValue(masked)).toBe(text);
          const reloaded = new Masker(
            [regex("secret", SECRET_PATTERN)],
            scanner,
            new Vault(seeded("reload"), vault.entries()),
            {},
            NO_FORMAT,
          );
          expect(reloaded.restoreValue(masked)).toBe(text);
        }),
        { seed: PROPERTY_SEED, numRuns: PROPERTY_RUNS },
      );
    },
    PROPERTY_TIMEOUT_MS,
  );

  it("leaves base64 that decodes to invalid UTF-8 as written and does not throw", async () => {
    const bytes = Buffer.from([0xff, 0xfe, 0x00, 0x81, 0xc3, 0x28, 0x90, 0x91]);
    const text = `blob ${bytes.toString("base64")} end`;
    const { masker } = build([regex("secret", SECRET_PATTERN)]);
    expect(await masker.mask([text])).toEqual([text]);
  });

  it("masks a secret percent-encoded byte by byte and restores it", async () => {
    const password = "SEC-abcdefGHIJKL";
    const text = `q=${percentEach(password)}&x=1`;
    const { masker, vault } = build([regex("secret", SECRET_PATTERN)]);
    const [masked] = await masker.mask([text]);
    expect(masked).not.toContain(password);
    expect(vault.entries().map(([real]) => real)).toEqual([
      password,
      percentEach(password),
    ]);
    expect(masker.restoreValue(masked)).toBe(text);
  });

  it("restores mixed-case percent escapes byte for byte", async () => {
    const password = "SEC-abcdefGHIJKL";
    const text = "q=%53%45%43%2D%61%62%63%64%65%66%47%48%49%4a%4B%4c&x=1";
    const { masker } = build([regex("secret", SECRET_PATTERN)]);
    const [masked] = await masker.mask([text]);
    expect(masked).not.toContain(password);
    expect(masker.restoreValue(masked)).toBe(text);
  });

  it("masks a plain secret next to malformed percent escapes and keeps the escapes", async () => {
    const password = "SEC-abcdefGHIJKL";
    const text = `a %G1 %2 % b ${password} %zz`;
    const { masker } = build([regex("secret", SECRET_PATTERN)]);
    const [masked] = await masker.mask([text]);
    expect(masked).not.toContain(password);
    expect(masked).toContain("%G1 %2 % b");
    expect(masked).toContain("%zz");
    expect(masker.restoreValue(masked)).toBe(text);
  });
});

describe("Masker generated values", () => {
  const PREFIX = "order ";
  const SUFFIX = " end";
  const SHAPE_RULE_IDS = new Set(["credit-card", "iban", "ipv4"]);
  const SHAPE_RULES: Rule[] = DEFAULT_RULES.map((rule): Rule =>
    SHAPE_RULE_IDS.has(rule.id) ? { ...rule, strategy: "shape" } : rule,
  );

  function luhnCheckDigit(payload: string): string {
    const sum = [...payload].reverse().reduce((total, char, index) => {
      const digit = Number(char) * (index % 2 === 0 ? 2 : 1);
      return total + (digit > 9 ? digit - 9 : digit);
    }, 0);
    return String((10 - (sum % 10)) % 10);
  }

  const syntheticCard = fc.stringMatching(/^[0-9]{14}$/).map((body) => {
    const payload = `4${body}`;
    return `${payload}${luhnCheckDigit(payload)}`;
  });
  const syntheticIban = fc.stringMatching(/^[0-9A-Z]{23}$/).map((bban) => {
    const digits = [...`${bban}FR00`]
      .map((char) =>
        /[A-Z]/.test(char) ? String(char.charCodeAt(0) - 55) : char,
      )
      .join("");
    const check = String(98 - Number(BigInt(digits) % 97n)).padStart(2, "0");
    return `FR${check}${bban}`;
  });
  const publicIpv4 = fc
    .tuple(
      fc.constantFrom(8, 145),
      fc.integer({ min: 0, max: 255 }),
      fc.integer({ min: 0, max: 255 }),
      fc.integer({ min: 0, max: 255 }),
    )
    .map((octets) => octets.join("."));
  const personalValue = fc.oneof(syntheticCard, syntheticIban, publicIpv4);

  async function maskAndRestore(
    scanner: Scanner,
    rules: readonly Rule[],
    value: string,
  ) {
    const sentence = `${PREFIX}${value}${SUFFIX}`;
    const masker = new Masker(
      rules,
      scanner,
      new Vault(seeded(`generated:${value}`)),
      {},
      NO_FORMAT,
    );
    const [masked] = await masker.mask([sentence]);
    return {
      sentence,
      masked,
      fake: masked.slice(PREFIX.length, masked.length - SUFFIX.length),
      restored: masker.restoreValue(masked),
    };
  }

  it("restores generated card, IBAN and IPv4 values byte-exact under the default rules", async () => {
    const scanner = new Scanner(2000);
    try {
      await fc.assert(
        fc.asyncProperty(personalValue, async (value) => {
          const { sentence, masked, restored } = await maskAndRestore(
            scanner,
            DEFAULT_RULES,
            value,
          );
          expect(masked).not.toBe(sentence);
          expect(masked).not.toContain(value);
          expect(restored).toBe(sentence);
        }),
        { seed: 401, numRuns: 100 },
      );
    } finally {
      scanner.close();
    }
  });

  it("gives generated default fakes the opaque form: same length, letters and digits only", async () => {
    const scanner = new Scanner(2000);
    try {
      await fc.assert(
        fc.asyncProperty(personalValue, async (value) => {
          const { sentence, masked, fake } = await maskAndRestore(
            scanner,
            DEFAULT_RULES,
            value,
          );
          expect(masked).not.toBe(sentence);
          expect(fake).toHaveLength(value.length);
          expect(fake).toMatch(/^[A-Za-z0-9]+$/);
        }),
        { seed: 402, numRuns: 100 },
      );
    } finally {
      scanner.close();
    }
  });

  it("restores generated card, IBAN and IPv4 values byte-exact under explicit shape rules", async () => {
    const scanner = new Scanner(2000);
    try {
      await fc.assert(
        fc.asyncProperty(personalValue, async (value) => {
          const { sentence, masked, restored } = await maskAndRestore(
            scanner,
            SHAPE_RULES,
            value,
          );
          expect(masked).not.toBe(sentence);
          expect(masked).not.toContain(value);
          expect(restored).toBe(sentence);
        }),
        { seed: 403, numRuns: 100 },
      );
    } finally {
      scanner.close();
    }
  });

  it("keeps explicit shape IPv4 fakes in dotted-quad form", async () => {
    const scanner = new Scanner(2000);
    try {
      await fc.assert(
        fc.asyncProperty(publicIpv4, async (value) => {
          const { sentence, masked, fake } = await maskAndRestore(
            scanner,
            SHAPE_RULES,
            value,
          );
          expect(masked).not.toBe(sentence);
          expect(isIPv4(fake)).toBe(true);
        }),
        { seed: 404, numRuns: 100 },
      );
    } finally {
      scanner.close();
    }
  });
});

describe("Masker call-local restores", () => {
  /** Seven small letters: below the learned-value length and not random-looking, so only a call-local mask covers it. */
  const SHORT = "hunterz";
  const passwordRule: Rule = {
    id: "password",
    type: "keyed",
    enabled: true,
    strategy: "shape",
    keys: ["password"],
    value: "[A-Za-z0-9]{7}",
  };

  it("reports each real that restoreValue puts back", async () => {
    const { masker } = build([passwordRule]);
    const [masked] = await masker.mask([`password=${SHORT}`]);
    const fake = masked.slice("password=".length);
    const restored = new Set<string>();
    expect(
      masker.restoreValue({ path: fake, rows: [{ value: fake }] }, restored),
    ).toEqual({ path: SHORT, rows: [{ value: SHORT }] });
    expect([...restored]).toEqual([SHORT]);
  });

  it("reports the decoded short real of a bound encoded fake", async () => {
    const { masker } = build([passwordRule]);
    const encoded = percentEach(`password=${SHORT}`);
    const [masked] = await masker.mask([encoded]);
    const restored = new Set<string>();
    expect(masker.restoreValue({ text: masked }, restored)).toEqual({
      text: encoded,
    });
    expect([...restored]).toContain(SHORT);
  });

  it("reports the decoded short real of a bound base64 fake", async () => {
    const { masker } = build([passwordRule]);
    const encoded = Buffer.from(`password=${SHORT}`).toString("base64");
    const [masked] = await masker.mask([encoded]);
    const restored = new Set<string>();
    expect(masker.restoreValue({ text: masked }, restored)).toEqual({
      text: encoded,
    });
    expect([...restored]).toContain(SHORT);
  });

  it("does not report a short real that a decoded leaf of a bound fake restores", () => {
    const OUTER = "Outer-Secret-Value";
    const vault = new Vault(seeded("short-leaf"));
    vault.fixedFor(SHORT, "ID-{n}", "");
    vault.fixedFor(OUTER, "%69%64%2D%31%20-{n}", "");
    const { masker } = build([], vault);
    const restored = new Set<string>();
    expect(
      masker.restoreValue({ text: "%69%64%2D%31%20-1" }, restored),
    ).toEqual({ text: OUTER });
    expect([...restored]).toEqual([OUTER]);
  });

  it("reports a decoded short real when the restored real also holds it as text", () => {
    const OUTER = `Outer ${SHORT}`;
    const vault = new Vault(seeded("short-plain"));
    vault.fixedFor(SHORT, "ID-{n}", "");
    vault.fixedFor(OUTER, "%69%64%2D%31%20-{n}", "");
    const { masker } = build([], vault);
    const restored = new Set<string>();
    expect(
      masker.restoreValue({ text: "%69%64%2D%31%20-1" }, restored),
    ).toEqual({ text: OUTER });
    expect([...restored]).toContain(SHORT);
  });

  it("masks a restored short value only in the call that restored it", async () => {
    const { masker } = build([passwordRule]);
    const [masked] = await masker.mask([`password=${SHORT}`]);
    const fake = masked.slice("password=".length);
    const restored = new Set<string>();
    masker.restoreValue({ text: `edit ${fake}` }, restored);
    expect(await masker.mask([`result ${SHORT}`])).toEqual([`result ${SHORT}`]);
    expect(await masker.mask([`result ${SHORT}`], [...restored])).toEqual([
      `result ${fake}`,
    ]);
  });
});

describe("Masker derived parts", () => {
  it("leaves a word of a learned host name as written elsewhere", async () => {
    const { masker } = build([
      literal("local-identity", ["buildhost-internal"]),
    ]);
    await masker.mask(["host buildhost-internal"]);
    const [masked] = await masker.mask(["see the internal docs"]);
    expect(masked).toBe("see the internal docs");
  });

  it("does not block a lowercase copy of a learned git user name", async () => {
    const { masker } = build([literal("local-identity", ["John Smith"])]);
    await masker.mask(["author John Smith"]);
    await expect(
      masker.assertNoHiddenReal(["https://github.com/johnsmith"]),
    ).resolves.toBeUndefined();
  });

  it("blocks a spaced-out token that holds the character of a one-character fake", async () => {
    const { masker } = build([literal("initials", ["jo"]), ...DEFAULT_RULES]);
    const [fake] = await masker.mask(["jo"]);
    const token = `ghp_${fake}VATh4IXRGeKOgzW5pO0KGKWzXxyMAkXSCsu`;
    await expect(
      masker.assertNoHiddenReal([[...token].join(" ")]),
    ).rejects.toThrow("HIDDEN_REAL");
  });

  it.each([
    ["in another case", "import { QUILLHARBOR } from './client';"],
    ["split by a space", "a Quill Harbor painting"],
    ["glued to a word", "new QuillHarborClient()"],
  ])("passes a learned word %s", async (_, text) => {
    const { masker } = build([literal("codename", ["QuillHarbor"])]);
    await masker.mask(["QuillHarbor"]);
    await expect(masker.assertNoHiddenReal([text])).resolves.toBeUndefined();
  });

  it.each([
    [
      "an env secret",
      DEFAULT_RULES.filter(({ id }) => id === "env-secret-names"),
    ],
    ["a literal", [literal("password", ["Huntr3ss-Fake-9wP"])]],
  ])("blocks %s reversed before any output holds it", async (_, rules) => {
    const { masker } = build(rules, undefined, {
      PGPASSWORD: "Huntr3ss-Fake-9wP",
    });
    await expect(
      masker.assertNoHiddenReal(["Pw9-ekaF-ss3rtnuH"]),
    ).rejects.toThrow("HIDDEN_REAL");
  });

  it("passes a learned run of digits inside a longer token", async () => {
    const { masker } = build([literal("digits", ["0123456789"])]);
    await masker.mask(["0123456789"]);
    await expect(
      masker.assertNoHiddenReal(['"abcxyz0123456789"']),
    ).resolves.toBeUndefined();
  });

  it.each([
    ["in groups", "Hunt r3ss -Fak e-9w P"],
    ["wrapped with CRLF", "Huntr3\r\nss-Fak\r\ne-9wP"],
  ])("blocks a learned value split %s", async (_, text) => {
    const { masker } = build([literal("password", ["Huntr3ss-Fake-9wP"])]);
    await masker.mask(["Huntr3ss-Fake-9wP"]);
    await expect(masker.assertNoHiddenReal([text])).rejects.toThrow(
      "HIDDEN_REAL",
    );
  });

  it("blocks a learned value with a digit in upper case", async () => {
    const { masker } = build([literal("password", ["secret42pass"])]);
    await masker.mask(["secret42pass"]);
    await expect(masker.assertNoHiddenReal(["SECRET42PASS"])).rejects.toThrow(
      "HIDDEN_REAL",
    );
  });

  it("masks a longer token that starts with a value learned in the same output", async () => {
    const { masker } = build(DEFAULT_RULES);
    const text =
      'key=qx_vbnm_Ka7pWd2R\nconst LONG = "qx_vbnm_Ka7pWd2Rz9LmTe4YbNc6HsJf";';
    const [masked] = await masker.mask([text]);
    expect(masked).not.toContain("qx_vbnm_Ka7pWd2R");
    await expect(masker.assertNoHiddenReal([masked])).resolves.toBeUndefined();
    expect(masker.restoreValue(masked)).toBe(text);
  });

  it("checks a payload text again once it holds a value learned after its check", async () => {
    const { masker } = build(DEFAULT_RULES);
    const text = "build_qx_vbnm_Ka7pWd2R";
    await expect(
      masker.assertNoHiddenRealInPayload([text]),
    ).resolves.toBeUndefined();
    await masker.mask(["key=qx_vbnm_Ka7pWd2R"]);
    await expect(masker.assertNoHiddenRealInPayload([text])).rejects.toThrow(
      "HIDDEN_REAL",
    );
  });

  it("checks a payload text again once it holds a fake learned after its check", async () => {
    const { masker } = build([
      literal("client", ["AcmeCorp"], "fixed", "Client{n}"),
      regex("gitleaks.probe", "[^a-z ]{4} tok_[a-z]{8}"),
    ]);
    const text = "Client1 tok_abcdefgh";
    await expect(
      masker.assertNoHiddenRealInPayload([text]),
    ).resolves.toBeUndefined();
    expect(await masker.mask(["AcmeCorp"])).toEqual(["Client1"]);
    await expect(masker.assertNoHiddenRealInPayload([text])).rejects.toThrow(
      "HIDDEN_REAL",
    );
  });

  it("checks a payload text again once a learned real spells its fake as NUL characters", async () => {
    const { masker } = build([
      literal("client", ["AcmeCorpTE1234567"]),
      regex("nul", "k-\\x00{8,}"),
    ]);
    const [fake] = await masker.mask(["AcmeCorpTE1234567"]);
    const text = `k-${fake}`;
    await expect(
      masker.assertNoHiddenRealInPayload([text]),
    ).resolves.toBeUndefined();
    await masker.mask([`k-${"\0".repeat(fake.length)}`]);
    await expect(masker.assertNoHiddenReal([text], false)).rejects.toThrow(
      "HIDDEN_REAL",
    );
    await expect(masker.assertNoHiddenRealInPayload([text])).rejects.toThrow(
      "HIDDEN_REAL",
    );
  });

  it("checks a payload text again after a check that failed", async () => {
    const { masker } = build([literal("password", ["secret42pass"])]);
    const payload = ["clean", "xsecret42pass"];
    await expect(masker.assertNoHiddenRealInPayload(payload)).rejects.toThrow(
      "HIDDEN_REAL",
    );
    await expect(masker.assertNoHiddenRealInPayload(payload)).rejects.toThrow(
      "HIDDEN_REAL",
    );
  });

  it("keeps a word glued with an underscore to a learned value clear in later output", async () => {
    const { masker } = build(DEFAULT_RULES);
    await masker.mask(["account TE1234567"]);
    const [glued] = await masker.mask(["deployment_te1234567 ok"]);
    expect(glued).toMatch(/^deployment_\w+ ok$/);
    expect(glued.toLowerCase()).not.toContain("te1234567");
    expect(await masker.mask(["run deployment now"])).toEqual([
      "run deployment now",
    ]);
  });

  it("passes code whose reversed reading holds a keyword of a token rule", async () => {
    const { masker } = build(DEFAULT_RULES);
    const code =
      "import { diffSystemPromptSections, normalizeBuildSystemPromptOptions } from './prompt';";
    await expect(masker.assertNoHiddenReal([code])).resolves.toBeUndefined();
  });

  it("blocks a plain hex line of a learned value whose hex has only octal digits", async () => {
    const { masker } = build([literal("password", ["secretpass"])]);
    await masker.mask(["secretpass"]);
    await expect(
      masker.assertNoHiddenReal([Buffer.from("secretpass").toString("hex")]),
    ).rejects.toThrow("HIDDEN_REAL");
  });

  it("blocks a spelled-out copy of a learned git email", async () => {
    const email = "ana.work@corp.example";
    const { masker } = build([literal("local-identity", [email])]);
    await masker.mask([`author ${email}`]);
    await expect(
      masker.assertNoHiddenReal([[...email].join(" ")]),
    ).rejects.toThrow("HIDDEN_REAL");
  });

  it("leaves a word of a socket path that a secret name selects", async () => {
    const socket = join(mkdtempSync(join(tmpdir(), "pms-")), "Listeners");
    mkdirSync(socket);
    const envRule = DEFAULT_RULES.filter(({ id }) => id === "env-secret-names");
    const { masker } = build(envRule, undefined, { SSH_AUTH_SOCK: socket });
    await masker.mask([`agent ${socket}`]);
    const [masked] = await masker.mask(["Listeners: 2"]);
    expect(masked).toBe("Listeners: 2");
  });

  // Joined at runtime so that secret scanners do not flag this made-up key.
  const LIVE = ["sk", "live", "KMgllWBGugLrBwD8UZ0gNPX5"].join("_");

  it("masks a random-looking part of a vault real that the call did not restore", async () => {
    const { masker } = build([literal("live", [LIVE])]);
    await masker.mask([`key ${LIVE}`]);
    const [masked] = await masker.mask(["last4 NPX5"]);
    expect(masked).not.toContain("NPX5");
    expect(masker.restoreValue(masked)).toBe("last4 NPX5");
  });

  it("masks a part of a vault real with the same part of its fake", async () => {
    const { masker } = build([literal("live", [LIVE])]);
    const [key] = await masker.mask([`key ${LIVE}`]);
    const fake = key.slice("key ".length);
    expect(await masker.mask(["last4 NPX5"])).toEqual([
      `last4 ${fake.slice(-4)}`,
    ]);
  });

  it("leaves a fake that the model altered as written", async () => {
    const { masker } = build([literal("live", [LIVE])]);
    const [key] = await masker.mask([`key ${LIVE}`]);
    const last = key.at(-1) === "a" ? "b" : "a";
    const altered = `${key.slice("key ".length, -1)}${last}`;
    const restored = new Set<string>();
    expect(masker.restoreValue(`key ${altered}`, restored)).toBe(
      `key ${altered}`,
    );
    expect([...restored]).toEqual([]);
  });

  it("leaves a token inside a fake as written when it is no prefix or suffix", () => {
    const vault = new Vault(seeded("inner"), [
      ["Secret-1234-abcd", "Qx7utf8Lp9Vb2Nm4"],
    ]);
    const { masker } = build([], vault);
    expect(masker.restoreValue("iconv -t utf8")).toBe("iconv -t utf8");
  });

  it("leaves a part of a fixed fake as written", () => {
    const vault = new Vault(seeded("fixed"), [["Secret1234", "PASSWORD_1"]]);
    const { masker } = build([], vault);
    expect(masker.restoreValue("export PASSWORD=x")).toBe("export PASSWORD=x");
  });

  it("leaves the tail of a fixed fake inside a longer word as written", () => {
    const vault = new Vault(seeded("fixed"), [
      ["acmecorpTheme", "company1Theme"],
    ]);
    const { masker } = build(
      [
        {
          ...regex("client", "(?<!\\w)\\w*(?<name>acmecorp)\\w*"),
          strategy: "fixed",
          replacement: "Company{n}",
        },
      ],
      vault,
    );
    expect(masker.restoreValue("x 1Theme")).toBe("x 1Theme");
  });

  it("restores a part of an opaque fake that holds a short fixed template", () => {
    const vault = new Vault(seeded("fixed"), [
      ["Rk7pQ2mZ4xLw", "Ab3c7Xy9QwEr"],
    ]);
    const { masker } = build(
      [literal("client", ["Globex"], "fixed", "C{n}")],
      vault,
    );
    expect(masker.restoreValue("x Ab3c7")).toBe("x Rk7pQ");
  });

  it("leaves a template word that is a part of a fixed fake as written after a reload", () => {
    const vault = new Vault(seeded("fixed"), [["s3cretKey", "REDACTED1"]]);
    const { masker } = build(
      [literal("secret", ["s3cretKey"], "fixed", "REDACTED{n}")],
      vault,
    );
    expect(masker.restoreValue("status REDACTED ok")).toBe(
      "status REDACTED ok",
    );
    expect(masker.restoreValue("status REDACTED1 ok")).toBe(
      "status s3cretKey ok",
    );
  });

  it("restores the first and last four characters of every opaque fake", async () => {
    const reals = Array.from({ length: 50 }, (_, index) =>
      `sk_live_${index}`.padEnd(32, "q"),
    );
    const { masker } = build([literal("live", reals)]);
    const fakes = await masker.mask(reals);
    const ends = fakes.map((fake) => `${fake.slice(0, 4)} ${fake.slice(-4)}`);
    expect(masker.restoreValue(ends)).toEqual(
      reals.map((real) => `${real.slice(0, 4)} ${real.slice(-4)}`),
    );
  });

  it("keeps no @ in the fake of a value that is not an email", async () => {
    const { masker } = build([literal("pass", ["p@ssw0rd!Xy9"])]);
    const [fake] = await masker.mask(["p@ssw0rd!Xy9"]);
    expect(fake).toMatch(/^[A-Za-z0-9]{12}$/);
  });

  it("restores a part of a fake to the same part of its real", async () => {
    const { masker } = build([literal("live", [LIVE])]);
    const [key] = await masker.mask([`key ${LIVE}`]);
    const fake = key.slice("key ".length);
    const restored = new Set<string>();
    expect(masker.restoreValue(`last4 ${fake.slice(-4)}`, restored)).toBe(
      "last4 NPX5",
    );
    expect([...restored]).toEqual(["NPX5"]);
  });

  it("leaves a part that occurs in two fakes as written", () => {
    const vault = new Vault(seeded("masker"), [
      ["Real1aaaa", "Xq7Kz4Lm9"],
      ["Real2bbbb", "Pw3Kz4Lm8"],
    ]);
    const { masker } = build([], vault);
    expect(masker.restoreValue("part Kz4Lm")).toBe("part Kz4Lm");
  });

  it("masks a part of eight or more characters of a vault real", async () => {
    const { masker } = build([literal("mail", ["billing.accounts@x.io"])]);
    await masker.mask(["to billing.accounts@x.io"]);
    const [masked] = await masker.mask(["user accounts"]);
    expect(masked).not.toContain("accounts");
  });

  it("masks a short word-like real that sits next to its fake, as in the vault file", async () => {
    const vault = new Vault(seeded("masker"), [["hunterz", "Qx7Lp9V"]]);
    const { masker } = build([], vault);
    const [masked] = await masker.mask(['[["hunterz","Qx7Lp9V"]]']);
    expect(masked).not.toContain("hunterz");
  });

  it("keeps a word-like or digit-only part of a vault real", async () => {
    const { masker } = build([literal("client", ["Acme-Corp-20245"])]);
    await masker.mask(["for Acme-Corp-20245"]);
    expect(await masker.mask(["Corp since 2024"])).toEqual(["Corp since 2024"]);
  });
});

describe("Masker placeholders", () => {
  const secret = "Sup3rSecretVal42";
  const otherSecret = "Acme-Corp-2024";

  it("masks a default-strategy value with an opaque placeholder of the same length", async () => {
    const { masker } = build([literal("client", [otherSecret])]);
    const [masked] = await masker.mask([`for ${otherSecret} only`]);
    expect(masked).toMatch(/^for [A-Za-z0-9]{14} only$/);
  });

  it("masks an explicit shape rule with a fake of the same character classes", async () => {
    const { masker, vault } = build([
      literal("client", [otherSecret], "shape"),
    ]);
    const [masked] = await masker.mask([`for ${otherSecret} only`]);
    expect(masked).toMatch(/^for [A-Z][a-z]{3}-[A-Z][a-z]{3}-\d{4} only$/);
    expect(vault.restore(masked)).toBe(`for ${otherSecret} only`);
  });

  it("leaves a placeholder unchanged across repeated provider passes", async () => {
    const { masker } = build([regex("secret", "\\b[A-Za-z0-9]{16}\\b")]);
    const [first] = await masker.mask([`key ${secret} end`]);
    const [second] = await masker.mask([first ?? ""]);
    expect(second).toBe(first);
  });

  it("ignores a provider span nested inside a placeholder, also inside an encoded placeholder", async () => {
    const vault = new Vault(seeded("masker"), [
      ["Secret-12345", "Qx7Lp9Vb2Nm4"],
    ]);
    const { masker } = build([regex("tag", "Vb2Nm4")], vault);
    const plain = "user Qx7Lp9Vb2Nm4";
    const encoded = base64(`x Qx7Lp9Vb2Nm4`);
    const [maskedPlain, maskedEncoded] = await masker.mask([plain, encoded]);
    expect(maskedPlain).toBe(plain);
    expect(maskedEncoded).toBe(encoded);
    expect(masker.restoreValue(maskedEncoded)).toBe(base64("x Secret-12345"));
  });

  it("blocks a provider span that only partly overlaps a placeholder", async () => {
    const vault = new Vault(seeded("masker"), [
      ["Secret-12345", "Qx7Lp9Vb2Nm4"],
    ]);
    const { masker } = build([regex("tag", "-Qx7")], vault);
    await expect(masker.mask(["x-Qx7Lp9Vb2Nm4"])).rejects.toMatchObject({
      code: "BLOCKED",
    });
  });

  it("restores a base64 run that holds a placeholder to the base64 of the real", async () => {
    const { masker } = build([literal("secret", [secret])]);
    const [placeholder] = await masker.mask([secret]);
    expect(masker.restoreValue(base64(`pw ${placeholder}`))).toBe(
      base64(`pw ${secret}`),
    );
  });

  it("round-trips base64 and percent-encoded secrets exactly", async () => {
    const { masker } = build([literal("secret", [secret])]);
    const basic = `Authorization: Basic ${base64(`ops:${secret}`)}`;
    const query = `https://db.example.test/?password=${encodeURIComponent(secret)}`;
    const [maskedBasic, maskedQuery] = await masker.mask([basic, query]);
    expect(masker.restoreValue(maskedBasic)).toBe(basic);
    expect(masker.restoreValue(maskedQuery)).toBe(query);
  });

  it("gives unknown tags no authority, even from another vault", async () => {
    const first = build([literal("secret", [secret])]);
    const second = build([literal("secret", [secret])]);
    const [placeholder] = await first.masker.mask([secret]);
    const unknown = "Zq8Lm2Vx7Tt9Pp3W";
    expect(second.masker.restoreValue(placeholder)).toBe(placeholder);
    expect(second.masker.restoreValue(unknown)).toBe(unknown);
  });
});

describe("Masker payload history", () => {
  const LATER = "VALUEAAAA1";
  const FRAGMENTS = [
    LATER,
    "VALUEBBBB2",
    `password=${LATER}`,
    "password=VALUEBBBB2",
    "LITERALXX9",
    base64(`password=${LATER}`),
    " ",
    "\n",
  ];
  const text = fc
    .array(fc.constantFrom(...FRAGMENTS), { minLength: 1, maxLength: 4 })
    .map((parts) => parts.join(" "));
  const op = fc.oneof(
    fc.record({
      kind: fc.constant("payload" as const),
      added: fc.array(text, { minLength: 1, maxLength: 2 }),
      /** Per history text: whether the session keeps its masked or its raw form. */
      keep: fc.array(fc.boolean(), { minLength: 16, maxLength: 16 }),
      failAt: fc.option(fc.integer({ min: 0, max: 2 })),
    }),
    fc.record({
      kind: fc.constant("mask" as const),
      fresh: fc.option(text),
      pick: fc.nat(),
    }),
  );

  /** `seeded` that throws from its `failAt`-th call while `failAt` is set, like a broken random source. */
  function breakable(seed: string) {
    const random = seeded(seed);
    const state: { calls: number; failAt: number | undefined } = {
      calls: 0,
      failAt: undefined,
    };
    const bytes: RandomBytes = (size) => {
      if (state.failAt !== undefined && state.calls++ >= state.failAt)
        throw new Error("random source failed");
      return random(size);
    };
    return { bytes, state };
  }

  async function outcome<T>(work: Promise<T>): Promise<T | string> {
    try {
      return await work;
    } catch (error) {
      return error instanceof Error ? error.message : String(error);
    }
  }

  it("masks each payload of a session as an uncached mask call does", async () => {
    const worker = new Scanner(2000);
    onTestFinished(() => worker.close());
    await fc.assert(
      fc.asyncProperty(
        fc.array(op, { minLength: 1, maxLength: 8 }),
        async (ops) => {
          const rules = [
            { ...regex("password", "password=([A-Z0-9]{10})"), group: 1 },
            literal("literal", ["LITERALXX9"], "shape"),
          ];
          const cached = breakable("history");
          const oracle = breakable("history");
          const subjectVault = new Vault(cached.bytes);
          const referenceVault = new Vault(oracle.bytes);
          const subject = new Masker(
            rules,
            worker,
            subjectVault,
            {},
            NO_FORMAT,
          );
          const reference = new Masker(
            rules,
            worker,
            referenceVault,
            {},
            NO_FORMAT,
          );
          let history: string[] = [];
          for (const step of ops) {
            if (step.kind === "mask") {
              const target =
                step.fresh ??
                history[step.pick % Math.max(history.length, 1)] ??
                LATER;
              expect(await outcome(subject.mask([target]))).toEqual(
                await outcome(reference.mask([target])),
              );
              continue;
            }
            const payload = [...history, ...step.added];
            cached.state.calls = oracle.state.calls = 0;
            cached.state.failAt = oracle.state.failAt =
              step.failAt ?? undefined;
            const got = await outcome(subject.maskPayload(payload));
            const want = await outcome(reference.mask(payload));
            cached.state.failAt = oracle.state.failAt = undefined;
            expect(got).toEqual(want);
            expect(subjectVault.entries()).toEqual(referenceVault.entries());
            if (Array.isArray(want))
              history = payload.map((raw, index) =>
                step.keep[index] ? want[index] : raw,
              );
          }
          expect(subjectVault.entries()).toEqual(referenceVault.entries());
        },
      ),
      { seed: 20261106, numRuns: 200 },
    );
  }, 60000);
});
