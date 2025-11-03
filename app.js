import express from "express";
import serverless from "serverless-http";
import { fetch } from "undici";
import dotenv from "dotenv";

dotenv.config();

// ===== Static config you will fill in =====
const BITRIX_LEAD_GET_URL = process.env.BITRIX_LEAD_GET_URL;
// Accept any of these status IDs as a pass condition:
const TARGET_STATUS_IDS = process.env.TARGET_STATUS_IDS.split(",");
// Webhook to notify when both conditions pass:
const OUTBOUND_WEBHOOK_URL = process.env.OUTBOUND_WEBHOOK_URL;

console.log(BITRIX_LEAD_GET_URL, TARGET_STATUS_IDS, OUTBOUND_WEBHOOK_URL);

// ==========================================

const app = express();
app.use(express.json());

// Healthcheck
app.get("/", (_, res) => res.status(200).json({ ok: true }));

/**
 * POST /onLeadUpdated
 * Expects body with Bitrix webhook payload.
 * - Pulls lead ID from body["data[FIELDS][ID]"]
 * - Fetches lead details from Bitrix
 * - Validates STATUS_ID ∈ TARGET_STATUS_IDS
 * - Validates MOVED_TIME is within the last 60 seconds (source is GMT-3 if no offset)
 * - If both pass -> POST { leadId } to OUTBOUND_WEBHOOK_URL
 */
app.post("/onLeadUpdated", async (req, res) => {
  try {

    // console.log(req);

    // Defensive parse for Bitrix key with brackets
    const leadIdRaw =
      req.body?.body?.["data[FIELDS][ID]"] ??
      req.body?.body?.data?.FIELDS?.ID ?? // just in case your source changes formatting
      req.body?.body?.ID;

    if (!leadIdRaw) {
      return res.status(400).json({ ok: false, error: "Lead ID not found in payload." });
    }

    const leadId = String(leadIdRaw).trim();

    // Call Bitrix lead.get
    const url = new URL(BITRIX_LEAD_GET_URL);
    url.searchParams.set("id", leadId);

    const bitrixResp = await fetch(url, { method: "GET" });
    if (!bitrixResp.ok) {
      const text = await bitrixResp.text().catch(() => "");
      return res.status(502).json({
        ok: false,
        error: "Bitrix lead.get failed",
        status: bitrixResp.status,
        body: text?.slice(0, 500)
      });
    }

    const payload = await bitrixResp.json();
    // The user’s example shows an array wrapper; Bitrix usually returns an object.
    // Support both shapes.
    const result = Array.isArray(payload) ? payload[0]?.result : payload?.result;
    if (!result || !result.ID) {
      return res.status(502).json({ ok: false, error: "Unexpected Bitrix response shape.", sample: payload });
    }

    const statusId = result.STATUS_ID || result.STATUS || result.STATUS_ID?.toString();
    const movedTimeRaw = result.MOVED_TIME || result.MOVED_TIME_UTC || result.MOVED_DATE;

    // ---- Status check
    const statusPass = TARGET_STATUS_IDS.includes(String(statusId));

    // ---- movedTime check (<= 60s ago)
    const movedPass = isWithinLastMinute(movedTimeRaw);

    if (statusPass && movedPass) {
      // Notify downstream webhook
      const notify = await fetch(OUTBOUND_WEBHOOK_URL, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ leadId })
      });

      if (!notify.ok) {
        const body = await notify.text().catch(() => "");
        return res.status(502).json({
          ok: false,
          error: "Downstream webhook failed",
          status: notify.status,
          body: body?.slice(0, 500)
        });
      }

      return res.status(200).json({ ok: true, forwarded: true, leadId });
    }

    console.log(`statusPass: ${statusPass}, movedPass: ${movedPass}`);
    console.log(`leadId: ${leadId}, statusId: ${statusId}, movedTime: ${movedTimeRaw}`);

    return res.status(200).json({
      ok: true,
      forwarded: false,
      reasons: {
        statusPass,
        movedPass
      },
      leadId,
      statusId,
      movedTime: movedTimeRaw
    });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ ok: false, error: err?.message || "Unhandled error" });
  }
});

/**
 * Parses a MOVED_TIME string and checks it is within the last 60 seconds.
 * Assumptions:
 * - If the string already contains a timezone offset (Z or ±HH:MM), we trust it.
 * - Otherwise, we treat it as GMT-3 (i.e., -03:00) per requirements.
 */
function isWithinLastMinute(movedTimeRaw) {
  if (!movedTimeRaw || typeof movedTimeRaw !== "string") return false;

  let iso = movedTimeRaw.trim();

  // If no timezone info present, append -03:00 (GMT-3)
  const hasOffset =
    /Z$/.test(iso) ||
    /[+-]\d{2}:\d{2}$/.test(iso);

  if (!hasOffset) {
    // If it's like "2025-11-03 17:06:27", make it ISO and add -03:00
    if (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(iso)) {
      iso = iso.replace(" ", "T") + "-03:00";
    } else if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/.test(iso)) {
      iso = iso + "-03:00";
    }
  }

  const movedDate = new Date(iso);
  if (isNaN(movedDate.getTime())) return false;

  const now = Date.now(); // UTC ms
  const diffMs = now - movedDate.getTime(); // positive if movedDate <= now
  // “Not further than a minute ago” => 0 <= diff <= 60000 ms
  return diffMs >= 0 && diffMs <= 60_000;
}

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Local server running on http://localhost:${PORT}`));