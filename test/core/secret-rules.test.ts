import { afterAll, describe, expect, it } from "vitest";
import { Scanner, type ScanPattern } from "../../src/core/scanner.ts";
import { SECRET_RULES } from "../../src/core/secret-rules.ts";

const scanner = new Scanner(5000);
afterAll(() => scanner.close());

const PATTERNS: ScanPattern[] = SECRET_RULES.flatMap((rule) =>
  rule.type === "regex"
    ? [
        {
          source: rule.pattern,
          flags: rule.flags,
          group: rule.group,
          keywords: rule.keywords,
          entropy: rule.entropy,
          allow: rule.allow,
        },
      ]
    : [],
);

/** The raw text of every span the secret rules report for `text`. */
async function found(text: string): Promise<string[]> {
  const [spans = []] = await scanner.scan(PATTERNS, [text]);
  return spans.map(([start, end]) => text.slice(start, end));
}

const ALNUM = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
const BASE64URL = `${ALNUM}-_`;

/**
 * Deterministic random text. Test values are built at run time, so no
 * secret-shaped literal sits in this file.
 */
function random(length: number, seed: number, alphabet = ALNUM): string {
  let state = seed;
  let text = "";
  for (let i = 0; i < length; i++) {
    state = (Math.imul(state, 1103515245) + 12345) >>> 0;
    text += alphabet[Math.floor((state / 2 ** 32) * alphabet.length)];
  }
  return text;
}

const VALUE = random(20, 1);
const BASIC = `${random(24, 9)}=`;

/** Unquoted values with one punctuation class each, built at run time. */
const PUNCTUATED = [
  `${random(6, 21)}.${random(4, 22)}!`,
  `${random(8, 23)}&${random(4, 24)}!`,
  `${random(6, 25)}:${random(4, 26)}`,
  `${random(5, 27)}(${random(4, 28)})${random(2, 29)}`,
  `${random(4, 30)}<${random(5, 31)}`,
  `${random(4, 32)},${random(5, 33)}`,
  `${random(4, 34)}@${random(4, 35)}!`,
];
const KEYED_FORMS = [
  (value: string) => `DB_PASSWORD=${value}`,
  (value: string) => `export DB_PASSWORD=${value}`,
  (value: string) => `password: ${value}`,
  (value: string) => `password=${value}`,
  (value: string) => `pwd = ${value}`,
];

describe("keyed secrets", () => {
  it.each([
    ["env", `DB_PASSWORD=${VALUE}`],
    ["quoted env", `export FOO_PASSWORD="${VALUE}"`],
    ["yaml", `password: ${VALUE}`],
    ["json", `{"password": "${VALUE}"}`],
    ["json escaped", String.raw`{\"password\":\"${VALUE}\"}`],
    ["snake and kebab keys", `client_secret: ${VALUE}\napi-key = ${VALUE}`],
    ["camel key", `clientSecret: "${VALUE}"`],
    ["upper suffix", `X_API_KEY='${VALUE}'`],
    ["access token", `access_token=${VALUE}&x=1`],
    ["private key", `private_key: ${VALUE}`],
    ["private key id", `"private_key_id": "${VALUE}"`],
    ["access key id", `ACCESS_KEY_ID=${VALUE}`],
    ["short pw key", `REDIS_PW=${VALUE}`],
    ["passcode key", `DB_PASSCODE=${VALUE}`],
    ["pat key", `AZURE_DEVOPS_EXT_PAT=${VALUE}`],
  ])("takes the value of a secret key in %s form", async (_form, text) => {
    expect(await found(text)).toContain(VALUE);
  });

  it("takes a short key only after a separator or as the whole key", async () => {
    expect(await found(`db_pass=${VALUE}`)).toEqual([VALUE]);
    expect(await found(`pwd: ${VALUE}`)).toEqual([VALUE]);
    expect(await found(`compass: ${VALUE}`)).toEqual([]);
    expect(await found(`bypass=${VALUE}`)).toEqual([]);
  });

  it("ignores stand-ins, code references and type names", async () => {
    const standIns = [
      `password: "\${DB_PASS}"`,
      `password=$DB_PASS`,
      `password: "{{ vault.pw }}"`,
      `password: "<your-password>"`,
      `password: "changeme"`,
      `token: "xxxxxxxx"`,
      `password: "***"`,
      `password: null`,
      `password: true`,
      `password: undefined`,
      `password: "process.env.PW"`,
      `password: "os.environ.get"`,
      `password: process.env.PW,`,
      `password: getPassword()`,
      `password: this.password,`,
      `password: string;`,
      `password: DB_PASSWORD`,
      `secret: secretAccessKey`,
      `apiKey: opts.apiKey,`,
      `password: abc`,
      `token: "/var/run/token"`,
      `const token = await this.refresh();`,
      `const credentials = typeof config.credentials;`,
      `if (token===null) return;`,
      `const STS_TOKEN = 'urn:ietf:params:oauth:token-type:jwt';`,
      `X_AWS_TOKEN = "x-aws-ec2-metadata-token"`,
      `const acorn_Token = read();`,
      `password: ${VALUE}==${VALUE}!==x`,
    ];
    for (const text of standIns) expect(await found(text), text).toEqual([]);
  });

  it.each([
    ["@Rk9xQ2mZ7", `password: "@Rk9xQ2mZ7"`],
    ["%21Qz8mT4vL", `password=%21Qz8mT4vL`],
    ["tr0ub4dor-h0rse-9x", `password: tr0ub4dor-h0rse-9x`],
    ["MyExample!2024", `password: "MyExample!2024"`],
    ["/Rk9xQ2mZ7", `password: "/Rk9xQ2mZ7"`],
    ["~Rk9xQ2mZ7", `password: "~Rk9xQ2mZ7"`],
    ["${DB_PW:-Rk9x7Q2mZ}", `password: \${DB_PW:-Rk9x7Q2mZ}`],
    ["$up3rS3cret", `password: "$up3rS3cret"`],
    ["<Xk9#mQ2pL7>", `password: "<Xk9#mQ2pL7>"`],
    ["{{Xk9#mQ2pL7}}", `password: "{{Xk9#mQ2pL7}}"`],
    ["{Rk9xQ2mZ7}", `password: "{Rk9xQ2mZ7}"`],
  ])("takes %s, which starts or ends like a stand-in", async (value, text) => {
    expect(await found(text)).toEqual([value]);
  });

  it.each([
    `password: "\${DB_PASSWORD}"`,
    `password: "<password>"`,
    `password: "%DB_PASSWORD%"`,
    `password: "{{.Values.pw}}"`,
    `password: "{{ vault.pw }}"`,
    `password: $PGPASSWORD`,
    `password: "./secrets/db.txt"`,
    `password: "~/.config/db/pw"`,
    `POSTGRES_PASSWORD: \${POSTGRES_PASSWORD:-postgres}`,
    `secret: '%env(APP_SECRET)%'`,
    `secret: '%kernel.secret%'`,
    `password: $env:DB_PASSWORD`,
    `Password={pwd};`,
    `password: @db.password@`,
    `"password":"[REDACTED]"`,
    `API_KEY=<your api key>`,
    `gcloud run deploy --token $(gcloud auth print-access-token)`,
  ])("ignores the stand-in %s", async (text) => {
    expect(await found(text)).toEqual([]);
  });

  it("ignores a code reference or call that ends a line", async () => {
    for (const text of [
      `password: this.password`,
      `apiKey: opts.apiKey`,
      `password: process.env.PW`,
      `password: getPassword()`,
    ])
      expect(await found(text), text).toEqual([]);
  });

  it("takes a quoted value with a dot, even when it is only words", async () => {
    expect(await found(`password: "Summer.Night"`)).toEqual(["Summer.Night"]);
  });

  it("ignores a keyed value made only of letters", async () => {
    for (const text of [
      `token: TOKEN`,
      `password: string`,
      `credentials: credentials`,
      `POSTGRES_PASSWORD: postgres`,
    ])
      expect(await found(text), text).toEqual([]);
  });

  it("takes a keyed value with a digit or a symbol", async () => {
    const mixed = ["Summer", "2024", "!"].join("");
    expect(await found(`password: ${mixed}`)).toEqual([mixed]);
  });

  it("takes an unquoted value with punctuation to the end of the text", async () => {
    for (const value of PUNCTUATED)
      for (const form of KEYED_FORMS) {
        const text = form(value);
        expect(await found(text), text).toEqual([value]);
      }
  });

  it("takes an unquoted value with punctuation before a newline", async () => {
    for (const value of PUNCTUATED)
      for (const form of KEYED_FORMS) {
        const text = `${form(value)}\nnext line`;
        expect(await found(text), text).toEqual([value]);
      }
  });

  it("takes an unquoted value with punctuation before a trailing comment", async () => {
    for (const value of PUNCTUATED)
      for (const form of KEYED_FORMS) {
        const text = `${form(value)} # rotate later`;
        expect(await found(text), text).toEqual([value]);
      }
  });

  it("leaves a trailing comma or semicolon out of an unquoted value", async () => {
    for (const value of PUNCTUATED)
      for (const text of [`password: ${value},`, `password: ${value};`]) {
        expect(await found(text), text).toEqual([value]);
      }
  });

  it("takes an unquoted value with punctuation before more text on its line", async () => {
    for (const value of PUNCTUATED)
      for (const form of KEYED_FORMS)
        for (const rest of [" psql -h db app", "; echo ok", " and more text"]) {
          const text = `${form(value)}${rest}`;
          expect(await found(text), text).toEqual([value]);
        }
  });

  it("ignores a code reference or call before more text on its line", async () => {
    for (const text of [
      `password: this.password || fallback`,
      `apiKey: opts.apiKey, timeout: 5`,
      `password: process.env.PW ?? ""`,
      `password: getPassword() + suffix`,
    ])
      expect(await found(text), text).toEqual([]);
  });

  it("ignores a word that ends a sentence after a key", async () => {
    for (const text of [
      `auth: required. Please log in.`,
      `password: required.`,
      `token: missing.\nnext line`,
    ])
      expect(await found(text), text).toEqual([]);
  });

  it("takes an unquoted value with punctuation in inline code", async () => {
    for (const value of PUNCTUATED) {
      const text = `Set \`password: ${value}\` in the file.`;
      expect(await found(text), text).toEqual([value]);
    }
  });

  it("keeps a query or connection string part out of an unquoted value", async () => {
    expect(await found(`password=${VALUE}&ssl=true`)).toEqual([VALUE]);
    expect(await found(`Password=${VALUE};Encrypt=True;`)).toEqual([VALUE]);
  });

  it("keeps a key after a backslash escape, tab, quote, %3D or =3D", async () => {
    const escapes = [
      String.raw`x\npassword=${VALUE}`,
      String.raw`x\tpassword=${VALUE}`,
      `x=3Dpassword=${VALUE}`,
      `x%3Dpassword=${VALUE}`,
      `x"password":"${VALUE}"`,
    ];
    for (const text of escapes)
      expect(await found(text), text).toEqual([VALUE]);
  });
});

describe("connection strings and credentials in arguments", () => {
  it.each([
    ["postgres", `postgres://app:${VALUE}@db.internal:5432/orders`],
    ["mysql", `mysql://app:${VALUE}@db-prod.internal:3306/orders`],
    ["mongodb srv", `mongodb+srv://svc:${VALUE}@cluster.mongodb.net/x`],
    ["amqp", `amqp://worker:${VALUE}@mq.internal:5672/jobs`],
    ["redis without user", `redis://:${VALUE}@cache.internal:6379/0`],
    ["escaped newline", String.raw`x\nmysql://app:${VALUE}@db:3306/x`],
  ])("takes the password of a %s URL", async (_scheme, text) => {
    expect(await found(text)).toEqual([VALUE]);
  });

  it.each([
    "%40Secret123",
    "Sunshine2024",
    "$up3rS3cret",
    "p4ss-w0rd",
    "$ECRET2024",
    "your_Xk9mQ2pL7vR4",
    "<Xk9#mQ2pL7>",
    "{{Xk9#mQ2pL7}}",
  ])("takes the URL password %s", async (password) => {
    expect(await found(`postgres://app:${password}@db:5432/x`)).toEqual([
      password,
    ]);
  });

  it.each([
    "password",
    "postgres",
    "abcdefghijklmno",
    "${DB_PASSWORD}",
    "$PGPASSWORD",
    "$DB_PASSWORD",
    "%DB_PASS%",
    "<password>",
    "{{db_password}}",
    "{{db.password}}",
    "****",
    "your-password",
    "YOUR_PASSWORD_HERE",
  ])("ignores the URL password stand-in %s", async (password) => {
    expect(await found(`postgres://app:${password}@db:5432/x`)).toEqual([]);
  });

  it.each([
    "root",
    "abcdefg",
    "abcdefghijklmnop",
    "correct_horse_battery_staple",
  ])(
    "takes a URL password of letters only outside 8 to 15 characters: %s",
    async (password) => {
      expect(await found(`postgres://app:${password}@db:5432/x`)).toEqual([
        password,
      ]);
    },
  );

  it.each([
    ["ado.net", `Server=tcp:db;User ID=svc;Password=${VALUE};Encrypt=True;`],
    ["ado.net pwd", `Server=db;Pwd=${VALUE};`],
    ["jdbc", `jdbc:mysql://db/app?user=svc&password=${VALUE}&ssl=true`],
    ["url token", `https://api.example.net/v1?access_token=${VALUE}&x=1`],
    ["url signature", `https://files.example.net/a.png?sig=${VALUE}`],
    ["pgpassword", `PGPASSWORD=${VALUE} psql -h db app`],
  ])("takes the secret of a %s parameter", async (_form, text) => {
    expect(await found(text)).toContain(VALUE);
  });

  it.each([
    ["mysql -p", `mysql -h db -u root -p${VALUE} app`, VALUE],
    ["mysql --password", `mysql --password ${VALUE} app`, VALUE],
    ["curl -u", `curl -u admin:${VALUE} https://api.example.net`, VALUE],
    [
      "docker login -p",
      `docker login -u ci -p ${VALUE} registry.example.net`,
      VALUE,
    ],
    [
      "authorization basic",
      `curl -H 'Authorization: Basic ${BASIC}' https://x`,
      BASIC,
    ],
    ["authorization token", `Authorization: token ${VALUE}`, VALUE],
  ])("takes the secret of a %s command", async (_form, text, secret) => {
    expect(await found(text)).toEqual([secret]);
  });

  it("ignores a variable reference passed as a command password", async () => {
    expect(await found(`mysql -u root -p$DB_PASS app`)).toEqual([]);
  });
});

describe("vendor formats", () => {
  const HEX36 = random(36, 2, "0123456789abcdef");
  const TELEGRAM_ID = random(9, 3, "0123456789");
  const TELEGRAM_TOKEN = random(35, 4, BASE64URL);

  it("takes a New Relic license key, also after escapes", async () => {
    expect(await found(`license=${HEX36}NRAL`)).toEqual([`${HEX36}NRAL`]);
    expect(await found(String.raw`x\n${HEX36}NRAL`)).toEqual([`${HEX36}NRAL`]);
  });

  it("ignores a 36-character hex run without the New Relic suffix", async () => {
    expect(await found(`id=${HEX36}`)).toEqual([]);
  });

  it("takes a Figma personal access token", async () => {
    const token = `figd_${random(40, 5, BASE64URL)}`;
    expect(await found(`token ${token} for sync`)).toEqual([token]);
  });

  it("takes a Telegram bot token, also inside an API URL", async () => {
    const token = `${TELEGRAM_ID}:${TELEGRAM_TOKEN}`;
    expect(await found(`https://api.telegram.org/bot${token}/getMe`)).toEqual([
      token,
    ]);
    expect(await found(`BOT_TOKEN=${token}`)).toContain(token);
  });

  it("takes a Dropbox short-lived access token", async () => {
    const token = `sl.${random(140, 6, BASE64URL)}`;
    expect(await found(`dropbox: ${token}`)).toEqual([token]);
  });
});

describe("structured credential formats", () => {
  const COOKIE = random(32, 7);
  const DB_PASS = random(16, 8);

  it("takes the value of a session cookie in a Cookie header", async () => {
    expect(await found(`Cookie: theme=dark; app_session=${COOKIE}`)).toEqual([
      COOKIE,
    ]);
  });

  it("takes the password of a netrc machine entry", async () => {
    const text = `machine mail.example.net login svc password ${DB_PASS}\n`;
    expect(await found(text)).toEqual([DB_PASS]);
  });

  it("takes the password field of a pgpass line", async () => {
    expect(
      await found(`warehouse.example.net:5433:sales:reporter:${DB_PASS}`),
    ).toEqual([DB_PASS]);
  });

  it("takes the value of a YAML block scalar under a secret key", async () => {
    expect(await found(`client_token: >-\n    ${VALUE}\n`)).toEqual([VALUE]);
    expect(await found(`db_passwd: |\n  ${DB_PASS}\n`)).toEqual([DB_PASS]);
  });

  it("takes the default of a Terraform variable named as a secret", async () => {
    const text = `variable "queue_secret" {\n  description = "broker credential"\n  default = "${DB_PASS}"\n}\n`;
    expect(await found(text)).toEqual([DB_PASS]);
  });

  it("takes the password of a SQL user statement", async () => {
    expect(
      await found(`CREATE ROLE reporting WITH PASSWORD '${DB_PASS}';`),
    ).toEqual([DB_PASS]);
    expect(
      await found(`ALTER USER 'svc'@'10.%' IDENTIFIED BY '${DB_PASS}';`),
    ).toEqual([DB_PASS]);
  });

  it("takes a keyed value quoted with an HTML or numeric entity", async () => {
    expect(await found(`{&quot;secret&quot;:&quot;${VALUE}&quot;}`)).toEqual([
      VALUE,
    ]);
    expect(await found(`&#34;clientSecret&#34;: &#34;${VALUE}&#34;`)).toEqual([
      VALUE,
    ]);
  });

  it.each([
    ["sshpass -p", `sshpass -p ${DB_PASS} scp backup.tar deploy@build:/srv`],
    [
      "sqlcmd -P",
      `sqlcmd -S reports-host -U report -P ${DB_PASS} -Q "select 1"`,
    ],
    ["redis-cli -a", `redis-cli -p 6380 -a ${DB_PASS} info`],
    [
      "ldapsearch -w",
      `ldapsearch -H ldap://dir -D uid=ops -w ${DB_PASS} -s base`,
    ],
    ["7z -p", `7z x -p${DB_PASS} archive.7z`],
    ["zip -P", `zip -P ${DB_PASS} -e secrets.zip notes.txt`],
    ["smbclient -U", `smbclient //files/public -U ops%${DB_PASS} -c ls`],
    ["htpasswd -b", `htpasswd -b users.htpasswd ops ${DB_PASS}`],
    ["rabbitmqctl add_user", `rabbitmqctl change_password ops ${DB_PASS}`],
    ["mongosh -p", `mongosh --host db2 -u ops -p ${DB_PASS}`],
    ["net user", `net user svcacct ${DB_PASS} /add /domain`],
    ["gh secret set", `gh secret set DEPLOY_TOKEN --body ${DB_PASS}`],
  ])("takes the secret of a %s command", async (_form, text) => {
    expect(await found(text)).toContain(DB_PASS);
  });
});

describe("more vendor formats", () => {
  const HEX = "0123456789abcdef";
  const UPPER_NUM = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ";
  const LOWER_NUM = "0123456789abcdefghijklmnopqrstuvwxyz";
  const UUID = [8, 4, 4, 4, 12].map((n, i) => random(n, 30 + i, HEX)).join("-");

  it.each([
    [
      "mapbox",
      `sk.eyJ${random(40, 20, BASE64URL)}.${random(22, 21, BASE64URL)}`,
    ],
    ["infisical", `st.${UUID}.${random(32, 22, HEX)}.${random(32, 23, HEX)}`],
    [
      "asana",
      `2/${random(16, 24, "0123456789")}/${random(16, 25, "0123456789")}:${random(32, 26, HEX)}`,
    ],
    ["fal", `${UUID}:${random(32, 27, HEX)}`],
    ["e2b", `e2b_${random(40, 28, HEX)}`],
    ["langsmith", `lsv2_pt_${random(32, 29, HEX)}_${random(10, 31, HEX)}`],
    ["mailchimp", `${random(32, 32, HEX)}-us12`],
    [
      "mailgun",
      `${random(32, 33, HEX)}-${random(8, 34, HEX)}-${random(8, 35, HEX)}`,
    ],
    ["mailgun legacy", `key-${random(32, 36, HEX)}`],
    ["klaviyo", `pk_${random(34, 58, LOWER_NUM)}`],
    ["age secret key", `AGE-SECRET-KEY-1${random(58, 59, UPPER_NUM)}`],
    ["axiom", `xaat-${UUID}`],
    ["twilio", `SK${random(32, 37, HEX)}`],
    ["tavily", `tvly-dev-${random(32, 38, LOWER_NUM)}`],
    ["neon", `napi_${random(64, 39, LOWER_NUM)}`],
    ["firecrawl", `fc-${random(32, 40, HEX)}`],
    ["trigger.dev", `tr_dev_${random(20, 41, UPPER_NUM)}`],
    ["shopify", `shpss_${random(32, 42, HEX)}`],
    ["new relic user key", `NRAK-${random(27, 43, UPPER_NUM)}`],
    ["hubspot", `pat-na1-${UUID}`],
    ["linear oauth", `lin_oauth_${random(64, 44, HEX)}`],
    [
      "braintree",
      `access_token$production$${random(16, 45, LOWER_NUM)}$${random(32, 46, HEX)}`,
    ],
  ])("takes the %s key", async (_vendor, token) => {
    expect(await found(`value ${token} here`)).toEqual([token]);
  });

  it("takes a percent-encoded bearer token", async () => {
    const token = `AAAAAAAAAAAAAAAAAAAAA${random(60, 47, BASE64URL)}%3D${random(20, 48, BASE64URL)}`;
    expect(await found(`Bearer ${token}`)).toEqual([token]);
  });

  it.each([
    (token: string) => `Authorization: Bearer ${token}`,
    (token: string) => `AUTHORIZATION: Bearer ${token}`,
    (token: string) => `authorization: bearer ${token}`,
    (token: string) => `authorization:Bearer ${token}\r\n`,
    (token: string) => `"Authorization": "Bearer ${token}"`,
    (token: string) => `-H 'Authorization: Bearer ${token}'`,
  ])(
    "takes a short bearer token after an Authorization key: %s",
    async (form) => {
      const token = random(8, 50);
      expect(await found(form(token))).toEqual([token]);
    },
  );

  it.each([
    "Authorization: Bearer undefined",
    "Authorization: Bearer REDACTED",
    "Authorization: Bearer xxxxxxxx",
    "Authorization: Bearer your-token-here",
    'headers: { Authorization: "Bearer test-token" }',
    '-H "Authorization: Bearer ACCESS_TOKEN"',
    "Authorization: Bearer accessToken",
    "Authorization: Bearer abcdefghijklmno",
    "Authorization: Bearer abc1234",
  ])("ignores a stand-in after an Authorization key: %s", async (text) => {
    expect(await found(text)).toEqual([]);
  });

  it.each(["abcdefghijklmnop", "xxxxxxxxxxxxxxxx", "your-token-goes-here"])(
    "takes a 16+ bearer token of letters: %s",
    async (token) => {
      expect(await found(`Authorization: Bearer ${token}`)).toEqual([token]);
    },
  );

  it("ignores a short word after Bearer outside an Authorization key", async () => {
    expect(await found("Send a Bearer abcd1234 token")).toEqual([]);
  });

  it("takes a secret from a markdown table cell under a key cell", async () => {
    const value = random(32, 49, LOWER_NUM);
    expect(await found(`| API_KEY | ${value} |`)).toEqual([value]);
  });
});

describe("key and value pairs in structured data", () => {
  const HEX32 = random(32, 50, "0123456789abcdef");
  const HEX32_B = random(32, 51, "0123456789abcdef");
  const PASS = random(16, 52);

  it("takes the value that follows a secret name in a Kubernetes env pair", async () => {
    const text = `containers:\n  - name: BILLING_API_KEY\n    value: "${HEX32}"\n`;
    expect(await found(text)).toEqual([HEX32]);
  });

  it("takes the value that follows a secret name in a HAR header pair", async () => {
    expect(await found(`{"name":"x-client-token","value":"${HEX32}"}`)).toEqual(
      [HEX32],
    );
  });

  it("takes the value that follows a secret name in a HAR form pair", async () => {
    expect(await found(`{"name":"passwd","value":"${PASS}"}`)).toEqual([PASS]);
  });

  it("takes the value of a sensitive Terraform output", async () => {
    const text = `"output": {"queue_secret": {"value": "${PASS}", "sensitive": true}}`;
    expect(await found(text)).toEqual([PASS]);
  });

  it("takes a header value in a Go header map", async () => {
    expect(
      await found(`trace: map[Host:[db] X-Access-Token:[${HEX32}]]`),
    ).toEqual([HEX32]);
  });

  it("takes the token that follows a Twilio account SID", async () => {
    const text = `sms.connect("AC${HEX32}", "${HEX32_B}")`;
    expect(await found(text)).toEqual([HEX32_B]);
  });

  it("takes a value after a bare hex Authorization header", async () => {
    expect(await found(`Authorization: ${HEX32}`)).toEqual([HEX32]);
  });

  it("takes the result of a random_password resource in state", async () => {
    const text = `{"mode":"managed","type":"random_password","name":"queue","instances":[{"attributes":{"result":"${PASS}!"}}]}`;
    expect(await found(text)).toEqual([`${PASS}!`]);
  });
});

describe("file-level credential formats", () => {
  const COOKIE = random(32, 53);
  const PUTTY_LINE = random(
    64,
    54,
    "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/",
  );

  it("takes the session value of a Netscape cookies row", async () => {
    expect(
      await found(
        `.shop.example.net\tFALSE\t/cart\tTRUE\t1893456000\tauth_session\t${COOKIE}`,
      ),
    ).toEqual([COOKIE]);
  });

  it("takes the private lines of a PuTTY key file", async () => {
    const text = `Private-Lines: 1\n${PUTTY_LINE}\n`;
    expect(await found(text)).toEqual([PUTTY_LINE]);
  });

  it("takes the body of a private key block cut off before its end line", async () => {
    const body = random(
      64,
      55,
      "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/",
    );
    expect(await found(`-----BEGIN EC PRIVATE KEY-----\n${body}\n`)).toContain(
      body,
    );
  });

  it("ignores an IPv6 host with a port in a URL", async () => {
    expect(await found("http://[fe80::2]:3000/@fs/src")).toEqual([]);
  });

  it("takes the password of a URL whose password holds a slash", async () => {
    const password = `${random(8, 56)}/${random(8, 57)}`;
    expect(
      await found(`postgres://reports:${password}@pg.example.net:5432/sales`),
    ).toEqual([password]);
  });
});
