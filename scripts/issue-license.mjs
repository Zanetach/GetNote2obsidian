import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

const LICENSE_PREFIX = "gns1";
const MAX_DEVICE_IDS = 3;

function parseArgs(argv) {
  const result = {};
  for (let index = 0; index < argv.length; index += 1) {
    const current = argv[index];
    if (!current.startsWith("--")) continue;
    const key = current.slice(2);
    const next = argv[index + 1];
    if (!next || next.startsWith("--")) {
      result[key] = "true";
      continue;
    }
    result[key] = next;
    index += 1;
  }
  return result;
}

function toBase64Url(input) {
  return Buffer.from(input)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

function normalizeExpiry(value) {
  if (!value || value.toLowerCase() === "never") {
    return "never";
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw new Error("`--exp` 必须是 YYYY-MM-DD 或 never");
  }
  return value;
}

function usage() {
  console.log([
    "用法：",
    "  npm run issue-license -- --device <deviceId[,deviceId2,...]> --exp <YYYY-MM-DD|never> [--customer 名称] [--unlimited]",
    "",
    "示例：",
    "  npm run issue-license -- --device mac-id,win-id,iphone-id --exp 2027-12-31 --customer Acme",
    "  npm run issue-license -- --exp 2027-12-31 --customer Acme --unlimited",
  ].join("\n"));
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const unlimited = args.unlimited === "true";
  if (args.help === "true" || !args.exp || (!args.device && !unlimited)) {
    usage();
    process.exit(args.help === "true" ? 0 : 1);
  }

  const privateKeyPath = args.key
    ? path.resolve(args.key)
    : path.resolve(process.cwd(), ".license/private-key.pem");

  if (!fs.existsSync(privateKeyPath)) {
    throw new Error(`找不到私钥文件：${privateKeyPath}`);
  }

  const payload = {
    deviceIds: unlimited
      ? []
      : String(args.device)
        .split(",")
        .map((item) => item.trim())
        .filter(Boolean),
    exp: normalizeExpiry(String(args.exp).trim()),
    customer: args.customer ? String(args.customer).trim() : undefined,
    unlimitedDevices: unlimited || undefined,
  };

  if (!unlimited && payload.deviceIds.length === 0) {
    throw new Error("至少需要提供一个 deviceId");
  }
  if (!unlimited && payload.deviceIds.length > MAX_DEVICE_IDS) {
    throw new Error(`单个授权码最多绑定 ${MAX_DEVICE_IDS} 台设备`);
  }

  const compactPayload = JSON.stringify(payload);
  const payloadBase64Url = toBase64Url(compactPayload);
  const signedContent = `${LICENSE_PREFIX}.${payloadBase64Url}`;
  const privateKey = fs.readFileSync(privateKeyPath, "utf8");
  const signature = crypto.sign("RSA-SHA256", Buffer.from(signedContent), privateKey);
  const signatureBase64Url = toBase64Url(signature);
  const license = `${LICENSE_PREFIX}.${payloadBase64Url}.${signatureBase64Url}`;

  console.log(license);
}

main().catch((error) => {
  console.error(error.message || error);
  process.exit(1);
});
