// Checks that a PII pattern's matched value must pass, so random digit runs and
// version strings are not masked. Each takes the matched value and returns true
// for a real value of its kind. Names are listed in VALIDATOR_NAMES in config.ts.
import { BlockList, isIPv4, isIPv6 } from "node:net";

function blockList(type, subnets) {
  const list = new BlockList();
  for (const [address, prefix] of subnets) list.addSubnet(address, prefix, type);
  return list;
}

// Not public: private, loopback, link-local, shared (RFC 6598), multicast and reserved.
const NON_PUBLIC_IPV4 = blockList("ipv4", [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.168.0.0", 16],
  ["224.0.0.0", 3],
]);

const NON_PUBLIC_IPV6 = blockList("ipv6", [
  ["::", 128],
  ["::1", 128],
  ["fe80::", 10],
  ["fc00::", 7],
]);

function luhnSum(digits) {
  let sum = 0;
  [...digits].reverse().forEach((char, index) => {
    const doubled = index % 2 === 1 ? Number(char) * 2 : Number(char);
    sum += doubled > 9 ? doubled - 9 : doubled;
  });
  return sum % 10 === 0;
}

export const CARD_CONTEXT = /^(?:card|card_number|pan)\s*[:=]\s*/i;

export function validPan(value) {
  const digits = value.replace(/[ -]/g, "");
  return /^(?:4\d{12,18}|(?:5[1-5]|2[2-7])\d{14}|3[47]\d{13}|6(?:011|5\d{2}|4[4-9]\d)\d{12,15})$/.test(digits) && luhnSum(digits);
}

function luhn(value, match) {
  const digits = value.replace(/[ -]/g, "");
  if (!CARD_CONTEXT.test(match)) return luhnSum(digits);
  return validPan(digits) || [3, 4].some((size) => validPan(digits.slice(0, -size)));
}

/** ISO 13616 mod-97 check: the rearranged number, with letters as 10 to 35, leaves 1. */
function iban(value) {
  const compact = value.replace(/ /g, "");
  if (!/^[A-Z]{2}\d{2}[A-Z0-9]{11,30}$/.test(compact)) return false;
  let remainder = 0;
  for (const char of `${compact.slice(4)}${compact.slice(0, 4)}`)
    for (const digit of String(parseInt(char, 36)))
      remainder = (remainder * 10 + Number(digit)) % 97;
  return remainder === 1;
}

/** The key is 97 minus the first 13 digits modulo 97. */
function frNir(value) {
  const compact = value.replace(/ /g, "");
  const body = compact.slice(0, 13).replace("2A", "19").replace("2B", "18");
  return 97 - (Number(body) % 97) === Number(compact.slice(13));
}

export const VALIDATORS = {
  "fr-nir": frNir,
  iban,
  luhn,
  "public-ipv4": (value) => isIPv4(value) && !NON_PUBLIC_IPV4.check(value, "ipv4"),
  "public-ipv6": (value) => isIPv6(value) && !NON_PUBLIC_IPV6.check(value, "ipv6"),
};
