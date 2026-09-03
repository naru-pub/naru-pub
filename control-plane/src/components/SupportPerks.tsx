// 후원으로 열리는 기능들을 한 줄씩 늘어놓는다. 첫 화면의 '사용 안내'와 같은
// 행 스타일이되, /support 카드들의 두꺼운 테두리에 맞춘다. 여기 적힌 기능은
// lib/entitlements의 PLAN_FEATURES.supporter와 일치해야 한다.
const PERKS = [
  {
    emoji: "🌐",
    title: "커스텀 도메인",
    description:
      "가지고 계신 도메인을 나루 웹사이트에 연결하고, 인증서까지 자동으로 발급받으실 수 있습니다.",
  },
  {
    emoji: "🗄️",
    title: "데이터베이스",
    description:
      "방명록이나 갤러리처럼 글과 파일을 담아두는 기능을 SDK로 붙이실 수 있고, 미디어 라이브러리도 함께 열립니다.",
  },
  {
    emoji: "📈",
    title: "방문자 현황",
    description:
      "어떤 글이 얼마나 읽혔는지, 어디에서 찾아왔는지를 날짜별로 보실 수 있습니다.",
  },
  {
    emoji: "🐙",
    title: "GitHub 배포",
    description:
      "GitHub 저장소에 올린 내용을 나루 웹사이트로 자동으로 배포하실 수 있습니다.",
  },
];

export function SupportPerks() {
  return (
    <div className="space-y-2 text-sm text-muted-foreground">
      {PERKS.map((perk) => (
        <div
          key={perk.title}
          className="border-2 border-border bg-background p-3"
        >
          <strong className="text-foreground">
            {perk.emoji} {perk.title}:
          </strong>{" "}
          {perk.description}
        </div>
      ))}
    </div>
  );
}
