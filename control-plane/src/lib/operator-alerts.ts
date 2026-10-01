// Alerts for the operators go to a Discord channel, through the webhook in
// OPERATOR_DISCORD_WEBHOOK_URL (a secret: anyone with it can post there, so
// it lives only in the server's environment). Not by mail.

// A Discord message holds at most 2000 characters.
const MAX_CONTENT = 2000;

export function operatorAlertsConfigured(): boolean {
  return Boolean(process.env.OPERATOR_DISCORD_WEBHOOK_URL);
}

// Posts one message: a title line, then as many lines as fit, and a note of
// how many did not with where to see them. Throws when Discord does not take
// it (a rate limit, an outage), so the caller can try again later.
export async function sendOperatorAlert(alert: {
  title: string;
  lines: string[];
  more?: string;
}): Promise<void> {
  const url = process.env.OPERATOR_DISCORD_WEBHOOK_URL;
  if (!url) throw new Error("OPERATOR_DISCORD_WEBHOOK_URL is not set");

  const note = (left: number) =>
    `\n… 외 ${left}건${alert.more ? ` — ${alert.more}` : ""}`;
  let content = `**${alert.title}**`;
  let shown = 0;
  for (const line of alert.lines) {
    // Room for the note, sized for the most it could say.
    const tail = shown + 1 < alert.lines.length ? note(alert.lines.length) : "";
    if (content.length + 1 + line.length + tail.length > MAX_CONTENT) break;
    content += `\n${line}`;
    shown += 1;
  }
  if (shown < alert.lines.length) content += note(alert.lines.length - shown);

  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    // Text as written: no @everyone or role pings from an event summary.
    body: JSON.stringify({
      content: content.slice(0, MAX_CONTENT),
      allowed_mentions: { parse: [] },
    }),
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) {
    throw new Error(
      `Discord webhook answered ${response.status}: ${(await response.text()).slice(0, 300)}`,
    );
  }
}
