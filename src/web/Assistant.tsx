export function Assistant({
  state = "idle",
  small = false,
}: {
  state?: "idle" | "working" | "success" | "error";
  small?: boolean;
}) {
  return (
    <svg
      className={`assistant ${state} ${small ? "small" : ""}`}
      viewBox="0 0 200 180"
      role="img"
      aria-label={
        {
          idle: "小梦在这里",
          working: "正在处理",
          success: "已完成",
          error: "需要重试",
        }[state]
      }
    >
      <defs>
        <linearGradient
          id={small ? "seed-small" : "seed"}
          x1="0"
          y1="0"
          x2="1"
          y2="1"
        >
          <stop stopColor="#c4e4ce" />
          <stop offset="1" stopColor="#74af98" />
        </linearGradient>
      </defs>
      <ellipse cx="102" cy="160" rx="51" ry="7" fill="#285348" opacity=".07" />
      <g className="seed-body">
        <path
          d="M46 114C28 82 44 37 79 30c19-5 24-18 36-10 10 6 4 19 20 23 30 8 42 36 29 68-10 26-37 39-62 38-28 0-45-13-56-35Z"
          fill={`url(#${small ? "seed-small" : "seed"})`}
        />
        <path
          d="M60 69c4-13 15-23 28-27"
          fill="none"
          stroke="#e5f3dc"
          strokeWidth="7"
          strokeLinecap="round"
          opacity=".6"
        />
        {state === "success" ? (
          <g stroke="#214d43" strokeWidth="5" fill="none" strokeLinecap="round">
            <path d="m78 88 5-4 5 4M114 88l5-4 5 4" />
          </g>
        ) : (
          <g fill="#214d43">
            <ellipse cx="84" cy="87" rx="4" ry={state === "working" ? 4 : 7} />
            <ellipse cx="120" cy="87" rx="4" ry={state === "working" ? 4 : 7} />
          </g>
        )}
        <path
          d={state === "error" ? "M96 106q6-5 12 0" : "M96 103q6 6 12 0"}
          fill="none"
          stroke="#214d43"
          strokeWidth="3"
          strokeLinecap="round"
        />
        <ellipse cx="69" cy="102" rx="8" ry="4" fill="#e7d7ad" opacity=".7" />
        <ellipse cx="134" cy="102" rx="8" ry="4" fill="#e7d7ad" opacity=".7" />
      </g>
      <path d="m163 30 3 8 8 3-8 3-3 8-3-8-8-3 8-3Z" fill="#d4b77b" />
    </svg>
  );
}
