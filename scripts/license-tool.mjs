import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import readline from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";

const LICENSE_PREFIX = "gns1";
const MAX_DEVICE_IDS = 3;

function toBase64Url(inputValue) {
  return Buffer.from(inputValue)
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
    throw new Error("到期时间必须是 YYYY-MM-DD 或 never");
  }
  return value;
}

function parseDeviceIds(raw) {
  return raw
    .split(/[\n,]/)
    .map((item) => item.trim())
    .filter(Boolean);
}

function buildLicense(payload, privateKeyPem) {
  const compactPayload = JSON.stringify(payload);
  const payloadBase64Url = toBase64Url(compactPayload);
  const signedContent = `${LICENSE_PREFIX}.${payloadBase64Url}`;
  const signature = crypto.sign("RSA-SHA256", Buffer.from(signedContent), privateKeyPem);
  const signatureBase64Url = toBase64Url(signature);
  return `${LICENSE_PREFIX}.${payloadBase64Url}.${signatureBase64Url}`;
}

async function main() {
  const privateKeyPath = path.resolve(process.cwd(), ".license/private-key.pem");
  if (!fs.existsSync(privateKeyPath)) {
    throw new Error(`找不到私钥文件：${privateKeyPath}`);
  }

  const rl = readline.createInterface({ input, output });

  try {
    output.write("\nGetNote Sync 发码工具\n\n");
    output.write("把客户发来的机器码逐行粘贴，或用逗号分隔都可以。\n\n");

    const customer = (await rl.question("客户名（可留空）: ")).trim();
    const exp = normalizeExpiry((await rl.question("到期时间（YYYY-MM-DD 或 never）: ")).trim());
    const unlimitedAnswer = (await rl.question("是否生成无限设备授权？(y/N): ")).trim().toLowerCase();
    const unlimitedDevices = unlimitedAnswer === "y" || unlimitedAnswer === "yes";

    let deviceIds = [];
    if (!unlimitedDevices) {
      output.write("\n请输入设备机器码，输入完成后回车两次结束：\n");
      const deviceLines = [];
      while (true) {
        const line = await rl.question("> ");
        if (!line.trim()) {
          break;
        }
        deviceLines.push(line);
      }

      deviceIds = parseDeviceIds(deviceLines.join("\n"));
      if (deviceIds.length === 0) {
        throw new Error("至少需要一个设备机器码");
      }
      if (deviceIds.length > MAX_DEVICE_IDS) {
        throw new Error(`单个授权码最多绑定 ${MAX_DEVICE_IDS} 台设备`);
      }
    }

    const payload = {
      deviceIds,
      exp,
      customer: customer || undefined,
      unlimitedDevices: unlimitedDevices || undefined,
    };

    const privateKeyPem = fs.readFileSync(privateKeyPath, "utf8");
    const license = buildLicense(payload, privateKeyPem);

    output.write("\n--- 授权信息 ---\n");
    output.write(`客户名: ${customer || "未填写"}\n`);
    output.write(`到期时间: ${exp}\n`);
    output.write(`授权范围: ${unlimitedDevices ? "无限设备" : `${deviceIds.length} 台设备`}\n`);
    if (!unlimitedDevices) {
      output.write(`${deviceIds.map((item, index) => `${index + 1}. ${item}`).join("\n")}\n`);
    }
    output.write("\n--- 授权码 ---\n");
    output.write(`${license}\n\n`);
  } finally {
    rl.close();
  }
}

main().catch((error) => {
  console.error(error.message || error);
  process.exit(1);
});
