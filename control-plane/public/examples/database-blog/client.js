import { config } from "./config.js";
export async function connect() {
  if (!config.site)
    throw new Error(
      "먼저 config.js의 site를 내 나루 로그인 이름으로 설정하세요. README.md를 참고하세요.",
    );
  const { createDatabase } = await import(
    `${config.controlPlaneOrigin}/sdk/1.0.0/naru-data.js`
  );
  return createDatabase({
    site: config.site,
    baseUrl: config.controlPlaneOrigin,
  });
}
