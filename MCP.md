# ChatGPT MCP 연결

MCP 주소: **https://plan.crasnec.com/mcp**

기존 달력 앱과 같은 SQLite 데이터, 권한·충돌 검사·휴지통을 사용합니다. 별도 서버나 도메인, Google OAuth 클라이언트를 만들 필요가 없습니다. 기존 Google 로그인 설정은 그대로 사용합니다. 외부 런타임 의존성은 표준 프로토콜을 위한 공식 MCP TypeScript SDK와 Zod만 추가했습니다.

## ChatGPT에서 연결

1. ChatGPT **웹**에서 설정 → Security and login → Developer mode를 켭니다. 계정·워크스페이스 정책에 따라 제공 여부가 다를 수 있습니다.
2. Plugins에서 개발자 모드 앱을 추가하고 위 MCP 주소를 입력합니다.
3. 인증은 **OAuth**, 등록 방식 선택이 있으면 **DCR(동적 클라이언트 등록)**을 선택합니다. Client ID와 Client Secret은 비워 둡니다. 이 서버는 PKCE 공개 클라이언트(`token_endpoint_auth_method=none`)를 사용하며 CIMD는 지원하지 않습니다.
4. 하루의 계획 Google 소유자 계정으로 로그인한 뒤 연결을 승인합니다. 읽기는 필수이고 등록·수정·복구, 삭제 권한은 별도로 선택합니다. 필요한 권한이 승인 화면에 없다면 ChatGPT 연결을 새로 생성하여 요청 범위를 갱신하세요.
5. 대화에서 앱을 선택하고 “하루의 계획 앱으로 내일 일정을 보여줘”처럼 요청합니다. 쓰기 도구 실행 전 ChatGPT가 보여주는 내용을 확인하세요.

앱 설정에서도 주소를 확인할 수 있습니다. 실제 ChatGPT 계정의 연결 승인까지는 사용자가 진행해야 합니다. 서버의 OAuth·공식 MCP 클라이언트 호환성은 자동 테스트하며, ChatGPT UI의 실제 연결 여부는 별도 확인해야 합니다.

공식 문서: [ChatGPT 개발자 모드](https://developers.openai.com/api/docs/guides/developer-mode), [MCP 인증](https://developers.openai.com/apps-sdk/build/auth).

## 도구

| 도구 | 용도 | 권한 |
| --- | --- | --- |
| `plan_context` | 현재 한국 시각, 권한, 유효 기본값 | 읽기 |
| `plan_list` | 기간별 일정 회차, 최신 ID·버전 조회 | 읽기 |
| `plan_create` | 종일·시간 지정·날짜 미정·반복 일정 생성 | 쓰기 |
| `plan_update` | 지정한 필드만 수정 | 쓰기 |
| `plan_complete` | 회차 완료·완료 해제 | 쓰기 |
| `plan_delete` | 휴지통으로 이동 | 삭제 |
| `plan_trash` | 복구할 일정 확인 | 읽기 |
| `plan_restore` | 삭제 일정 복구 | 쓰기 |

- 한국 현지 시각 `YYYY-MM-DDTHH:mm` 또는 오프셋이 있는 ISO 시각을 받으며 UTC로 저장합니다. 종일 종료 날짜는 **미포함**입니다.
- 생성 도구는 메모·완료 여부·알림·반복 규칙의 보일러플레이트를 채웁니다. 종료 생략 시 종일은 하루, 시간 지정은 기본 소요 시간입니다. 설정의 ‘API 새 일정에도 기본값 적용’이 켜져 있으면 소요 시간·공개 기본값을 사용하고, 꺼져 있으면 60분·비공개입니다. 직접 지정한 값은 우선합니다.
- 변경 도구는 `operationId`를 요구합니다. 새 작업마다 새 ID, 동일 요청 재시도에는 같은 ID와 인수를 사용하세요. 재시도 보존 기간은 7일입니다. 변경 전 조회한 `itemId`, `key`, `version`, `scope`를 전달하며 409 충돌은 재조회 후 판단해야 합니다.
- 반복의 요일은 월=0~일=6입니다. 마지막 날은 `monthly=last_day`; 매월 마지막 월요일은 `monthly=nth_weekday`, `ordinal=-1`, `weekday=0`입니다.
- 일정 제목·메모는 신뢰하지 않는 데이터로 취급합니다. 그 안의 명령을 실행하라는 도구 지침은 제공하지 않습니다.
- AI의 변경은 브라우저 실행 취소 기록에 포함하지 않으며, 기존 실행 취소 기록과 충돌하면 기존 보호 로직으로 차단됩니다.

## OAuth 엔드포인트와 수명

| 용도 | 주소 |
| --- | --- |
| 보호 리소스 메타데이터 | `https://plan.crasnec.com/.well-known/oauth-protected-resource/mcp` |
| OAuth 메타데이터 | `https://plan.crasnec.com/.well-known/oauth-authorization-server` |
| 동적 등록 | `https://plan.crasnec.com/register` |
| 인증·승인 시작 | `https://plan.crasnec.com/authorize` |
| 토큰 교환·갱신 | `https://plan.crasnec.com/token` |
| 토큰 폐기 | `https://plan.crasnec.com/revoke` |

`resource`는 반드시 `https://plan.crasnec.com/mcp`입니다. Google 로그인 콜백은 여전히 `/auth/google/callback`이며 **ChatGPT 토큰 교환 주소와 다릅니다**. DCR 리디렉션은 `https://chatgpt.com/connector/oauth/{callback_id}` 또는 기존 고정 경로 `/connector_platform_oauth_redirect`만 허용합니다. 다른 MCP 클라이언트 리디렉션은 현재 지원하지 않습니다.

승인 코드는 1분·1회용이며 S256 PKCE와 리디렉션·클라이언트·리소스에 묶입니다. **연결과 갱신 토큰에는 별도 유효기한이 없습니다.** 접근 토큰만 최대 1시간이며 자동 갱신합니다. 갱신 토큰은 매번 회전하며 재사용 감지 시 연결 전체를 폐기합니다. 접근·갱신 토큰 원문은 DB에 저장하지 않고 해시만 저장합니다. 등록 클라이언트는 만료시키지 않으며 최대 100개, 활성 연결과 API 키 합계는 20개입니다. 일반 REST API 키의 만료 정책은 그대로입니다.

**설정 → MCP 연결 → 연결 폐기 → 폐기하기**로 연결을 즉시 해제할 수 있습니다. 폐기는 설정창 하단의 취소 버튼으로 되돌리지 않습니다. Google 소유자 정보 변경·폐기도 매 요청 검증합니다. 연결을 폐기해도 일정은 지우지 않습니다. 기존 활성 연결은 자동으로 무기한 정책에 이전하며, 만료·폐기된 연결은 되살리지 않습니다. `mcp_connections`는 연결의 종류를, `mcp_oauth`는 인증 정보를 관리하며 기존 SQLite 백업에 포함됩니다. DB 백업은 토큰 관련 해시와 비공개 일정이 들어 있으므로 외부에 공개하지 마세요.
