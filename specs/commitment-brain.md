# 承诺大脑(Commitment Brain)— 总体蓝图

Status: PROPOSED (2026-08-22)。来源:owner 的认知科学书单(Winograd & Flores、
Searle、会话分析、前瞻记忆、Schacter、关联理论、延展心智)× 本系统的实测失败目录
(303 条 open vs 实际 ~15 件事;说话人误归 8 中 6;陈旧无界;细节串染 U2B-E24→U2A8;
Echo/朱桦隐形;做完永不关闭)。六个理论模块并行设计 + 交叉批判后的收敛稿;模块
原稿与批判全文见会话工作目录,本文自足。

---

## 0. 设计公理(全文的宪法,冲突时以此为准)

1. **照搬大脑的功能分解,不照搬实现机制**(owner 原话)。Zeigarnik 给的是
   「未闭合必须高可及」这个功能需求,用状态机实现,不模拟衰减曲线。
2. **凡是只写在 prompt 里的规则都会被违反;凡是代码强制的都活了下来**(血泪史)。
   每条规则必须标注执行层:LLM(只提名)/ 代码(强制)/ owner(裁决)。
3. **LLM 提议 → 代码把关 → owner 裁决 → 裁决变成新的代码把关。** 回流强度递减:
   code > threshold > prompt_example,能落前两档的永不落第三档。
4. **激进遗忘是特性**:不遗忘的系统把用户淹死。契约是「没有任何东西未经你过目
   就消失」,不是「所有东西永远都在」。
5. **静默失败是最高级故障**,与账本-表面漂移同级。每条被拒绝/降级/遗忘的数据都
   带原因码,进 digest,可 audit。
6. **组织不是信息流,是承诺网络**(Winograd & Flores):账本里的一条记录不是
   "信息",是有两个当事人、有生命周期的社会对象,由言语行为创建、推进、关闭。

## 1. 双向认知模型

```
捕获(持续,自底向上)                    决策(渲染时,自顶向下)
消息 ─→ 这是谁(persona,机械解析)        matter 注册表(~15 件,owner 独占定义权)
     ─→ 这是什么行为(言语行为分类,LLM)     ─→ 每件:活跃环节在谁?
     ─→ 欠了谁什么(CfA 状态机,代码)        ─→ 在我 → 一个下一步动作 = 一行
     ─→ 归哪件事(matter,LLM 提名+门)       ─→ 在别人 → 跟踪,不上列表
        归不了 → 无主收件箱,不入账          ─→ 有日期 → 按日期自浮
```

层次:信号层(L0 机械滤)→ 言语行为层(L1 分类)→ 承诺网络层(CfA 状态机 + R1
守卫库)→ Matter 层 → 浮现层(纯派生)→ 交互层(手势即转移)。

## 2. 唯一状态机:Conversation for Action

批判裁决 P0-1:全系统**只有这一台状态机**。相邻对(adjacency pair)机制折叠为
pre-COMMITTED 段;遗忘的 stale/archived 是可见度阶梯不是状态;overdue 是
`due < now ∧ open` 的派生视图,**永不落盘为状态**(把视图当状态存,存了就永远
不更新,是失败#6 的半个病根)。

### 2.1 角色与状态

两个角色,与"人"解耦:**requester**(债权人)/ **performer**(债务人)。owner
和对方都可占任一角色;所有转移按角色定义,"双方都可发起"免费得到。

```typescript
type CommitmentState =
  // open 态
  | 'REQUESTED'   // 有人提了要求,还没人接(≈相邻对 SLOT_OPEN)
  | 'OFFERED'     // 有人主动承诺,对方还没认领
  | 'HEDGED'      // 模糊应答中间态(「我看看」),带时钟,绝不是承诺
  | 'COMMITTED'   // 承诺成立 —— 唯一可渲染为列表行的状态
  | 'REPORTED'    // performer 声称完成,待验收
  // closed 终态(全部留墓碑)
  | 'CLOSED_DONE'         // 验收通过
  | 'CLOSED_DECLINED'     // performer 拒接(含委婉拒绝收敛)
  | 'CLOSED_WITHDRAWN'    // requester 在承诺成立前撤回
  | 'CLOSED_RENEGED'      // performer 在承诺成立后食言 —— 一等公民
  | 'CLOSED_CANCELLED'    // requester 在承诺成立后叫停
  | 'CLOSED_TRANSFERRED'  // 转让(「让小王来对接」),受让新承诺进裁决队列
  | 'CLOSED_SUPERSEDED'   // 条款变更:关旧开新,supersedes 链(替代原地 NEGOTIATING)
  | 'CLOSED_LAPSED';      // 系统遗忘(见 §6),唯一可凭新证据申请复活的终态
```

Renege/Withdraw/Cancel 的命名是**机械查表**,不靠 LLM 措辞判断:承诺成立前由
requester 关 = WITHDRAWN;成立后由 performer 关 = RENEGED,由 requester 关 =
CANCELLED。LLM 只分类"这是一句关闭话语",关成哪个终态由「当前状态 × 说话人
角色」决定。

### 2.2 主干转移

```
directive(requester) ──→ REQUESTED ──commissive(performer)──→ COMMITTED
commissive(performer,自发) ──→ OFFERED ──declaration(requester 认领)──→ COMMITTED
REQUESTED ──HEDGE(performer)──→ HEDGED ──后续 commissive──→ COMMITTED
                                        └─时钟到期──→ CLOSED_LAPSED
counteroffer(任一方) = 关旧(CLOSED_SUPERSEDED)+ 开新(带 supersedes 指针)
COMMITTED ──assertive(performer:「发你了」)──→ REPORTED
REPORTED ──declaration(requester)──→ CLOSED_DONE
         └─directive(requester:「还差X」)──→ 回 COMMITTED
任何 open 态 ──owner 手势 / 系统时钟──→ 对应 CLOSED_*
```

### 2.3 Schema(账本 v2)

```typescript
interface Evidence {
  msg_id: string;      // 平台消息 id
  speaker_key: string; // ⚠️ 代码从消息元数据 resolve,LLM 无权填写
  quote: string;       // 必须是 msg_id 那【一条】消息的逐字子串
  at: string;          // 消息时间戳(元数据,非 LLM)
}
type TransitionEvidence =
  | { kind: 'utterance'; ev: Evidence }
  | { kind: 'owner_adjudication'; gesture: string; at: string }
  | { kind: 'system'; reason: 'lapse'|'migration'|'auto_accept'; at: string };

interface Transition {
  seq: number;
  from: CommitmentState | null;   // null = 铸造
  to: CommitmentState;
  act: SpeechAct;                 // §3 的单一枚举
  actor_role: 'requester' | 'performer';
  evidence: TransitionEvidence;
}

interface Commitment {
  id: string;
  matter_id: string;              // 必填。归不了 matter 不入账
  requester: PersonaKey;
  performer: PersonaKey;          // who: me|them 的继任者
  what_gloss: string;             // 动词/描述部分,LLM 可改写
  entities: AnchoredEntity[];     // 实体部分,逐字锚定(§4 G3)
  due?: string;
  anchor: Anchor;                 // §5,必填(time/event/none)
  flags: { has_money: boolean; has_contract: boolean; pinned: boolean };
  history: Transition[];          // append-only,唯一事实来源
  supersedes?: string;
  // state 不落盘:state = fold(history)。读取时重放校验,不一致→响亮报错
}
```

`state = fold(history)` 是关键:LLM 和任何 bug 都无法"直接改状态",只能追加
一条要过全部门的转移。needs_leo 的 LLM verdict **废除**(批判#22),改为派生:
`需要我 ≡ performer == owner ∧ state == 'COMMITTED'`,少一个模型判断。

## 3. 言语行为层(单一枚举,一次分类)

批判裁决 P2-11:全系统一个枚举、一次 LLM 分类调用。

```typescript
type SpeechAct = {
  type: 'directive' | 'commissive' | 'assertive' | 'declaration' | 'expressive';
  strength?: 'strong' | 'hedged' | 'conditional';   // commissive 专用子标签
};
```

| 类型 | 状态机权力 | 例 |
|---|---|---|
| directive | 唯一能开 REQUESTED;可发 renegotiate、拒收 REPORTED | 「帮我把BOM发给张工」 |
| commissive·strong | 唯一能创建义务:开 OFFERED 或推 →COMMITTED。**义务人=说话人,无例外** | 「好的我今天发你」 |
| commissive·hedged | → HEDGED,绝不入 COMMITTED | 「我看看」「应该可以」「尽量」 |
| commissive·conditional | → COMMITTED 但带 blocked_on,不渲染 | 「等样品到了我就寄」 |
| assertive | 只能推进已存在的承诺(→REPORTED),**永不能创建** | 「发你了」「型号是U2B-E24」 |
| declaration | 关闭类转移与谈判定案 | 「不用了」「就这么定了」 |
| expressive | 零权力(REPORTED 下 requester 的「谢谢」生成 suggest-accept 提示) | 「辛苦了」 |

**中文模糊语分类表**(preference organization:中文的拒绝以模糊语形态出现,
模糊语是信号不是噪音)作为分类 prompt 的附录:强承诺(好的我今天发/没问题周五前)、
努力性模糊(尽量/争取/应该可以≈60%,**不是 yes**)、委婉拒绝前兆(有点难/最近
比较忙/要问一下老板→declination)、拖延性关闭(先放放——按说话人角色分流:
requester 说=WITHDRAW,performer 说=HEDGE)。

**ACK 规则**(owner 裁决,2026-08-22,取代原「永久人工裁决」设计):「收到」的
含义由它回应的 FPP 的内容机械决定 ——
FPP 是 directive ∧ 含具体交付物(过 G9)∧ 指向 owner → ACK = 接受,推
REQUESTED→COMMITTED(证据 = ACK 话语本身);FPP 是 assertive/FYI/通知 →
ACK = 归档为知识,零承诺。边界情况(directive 但交付物模糊)→ 裁决队列。
L0 的 ack 短语过滤加旁路(批判#7):短语时序上跟在某 open REQUESTED 之后且
同会话 → 放行进分类,否则 CONTEXT_ONLY。

**Frame 单向阀**(Goffman):代码算 prior(渠道/群vs私聊/关系/matter 绑定),
LLM 只许把 work 降为 social,**不许把 social 升为 work**(升格需命中机械白名单:
金额/日期/matter 关键词/型号 entity,且只进 owner 队列)。失败#1 的方向是过度
入账,阀门只朝少入账方向开。

## 4. R1 守卫函数库(全部门在一处实现一次)

批判裁决 P2-19:speaker gate 被四个模块各定义一遍——语义收敛是好事,实现必须
唯一,否则五处漂移。R1 写入关卡扩展为守卫函数库,各调用方只声明用哪些门:

| 门 | 规则(全部代码强制) | 防 |
|---|---|---|
| G1 speaker | 转移的 evidence.speaker_key 由代码从 msg_id 元数据 resolve;守卫表校验该转移要求的角色持有人 == 真实说话人。commissive 的说话人 ≠ performer → 整条拒绝。「对方说你答应过」= claimed-by-them,进裁决队列不自动入账 | **#2** |
| G2 single-message quote | quote 逐字 ∈ msg_id 指向的那一条消息(不是全语料——串染的常见形态就是从邻近消息借细节) | #4 |
| G3 entity anchoring | what 里的型号/数量/金额/日期 token(regex 闭集抽取,LLM 只能选不能造)必须是本承诺某条 evidence.quote 的逐字子串;渲染时实体从模板变量注入,永不过 LLM 改写通道 | **#4** |
| G4 addressee | 群聊 directive 指向 owner 需 @mention 或逐字含 owner 称呼(per-persona 称呼表);皆无 → 只进裁决队列 | #2,#1 |
| G5 recency | 铸造证据的消息时间戳必须在滚动窗内(默认 14 天);**窗外消息保留在语料里作上下文与关闭比对,只是丧失铸造权**(批判#20) | **#3** |
| G6 date re-derivation | LLM 给 due 必须附逐字日期表达 quote;代码用确定性解析器以**消息时间戳**(不是 now)为基准重新解析,不一致 → 拒绝时间锚。几个月前的「下周五」解析出早已过去的日期,当场暴露 | #3,#4 |
| G7 matter | state 可为 open 的必要条件:matter_id ∈ owner 注册表。归不了 → 无主收件箱(PARKED),不入账;同人/同关键词 PARKED ≥3 → digest 提议建新 matter,**matter 只能由 owner 创建** | **#1** |
| G8 closure-binding | 闭合证据关的是**哪一条**:speaker == 该承诺 performer + matter 一致 + (实体重叠 ∨ 同 thread);前两条必须满足,否则降级为「疑似关闭」一键项(批判#8:不设这道门,串染会在关闭侧重演,且关闭是自动执行方向) | #4,#6 |
| G9 substance | what 必须含可交付物:名词短语+(动词∨entity∨due);doneWhen 非空且不命中废话表。纯情态句/无宾语祈使/RHETORICAL 连 Pair 都不开 | #1 |
| G10 coverage 守恒 | 每轮:归入 persona 的消息数 + unresolved 数 == 扫描总数,不等即响亮崩。persona 载入 schema 校验失败 = 该联系人全部消息计入 unresolved + digest 红条(朱桦案) | **#5**,#7 |
| G11 render invariant | 断言:每条 `performer=owner ∧ COMMITTED` 出现在某个可达表面(主列表∨brief 分区∨周 review),差集非空即报错(Zeigarnik 的机械形式) | #7 |
| G12 tombstone 幂等 | 终态承诺同 key 再现,必须新证据 ts > 终态时间才可造 gen+1(任务层墓碑机制上提为承诺层通则) | 已修#7 战果 |

**废除**(批判裁决):salience 门B「三问」自评(prompt 自评伪装成门)、
llm_confidence 字段(无机械消费者)、per-person/per-matter 参数自动调整(自改
配置;参数只能 owner 在周 review 手改)、入账层 cap(丢信息;cap 只在浮现层)。

## 5. 触发与浮现(前瞻记忆)

每条承诺入账时**必须**绑定锚(R1 拒写):

```typescript
type Anchor =
  | { kind: 'time';  due: ISODate }                    // 过 G6 复推导门
  | { kind: 'event'; cue: { type: 'reply_from'|'commitment_closed'|'matter_state'; ref: string } }
  | { kind: 'none' };                                   // 合法,但必须显式写出
// 没有 location 类型:系统无位置信号源,不可机检的锚不许 LLM 发明
```

**浮现层是纯派生函数**(批判#14:第二台落盘状态机=双写漂移)。只持久化三个
字段:`snooze_until / nudge_at / review_misses`,DORMANT/ARMED/SURFACED/WAITING
全部现算:

| 派生态 | 主列表 | 每日 brief | 周 review |
|---|---|---|---|
| SURFACED(matter 的唯一下一步) | **是** | 镜像 | 是 |
| ARMED(锚已触发,竞争中) | 否 | 候补区(折叠) | 是 |
| WAITING(球在对方,nudge_at 到期→「该催了」区) | 否 | 等待区 | 是 |
| DORMANT(无锚/未触发) | 否 | 否 | **是(唯一出口)** |

**Cap 只设在浮现层**(批判 P0-4):主列表每 matter ≤1 行(owner 的「一个下一步
动作」);账本无硬 cap,每 matter open>5 触发系统告警(说明上游门在漏,不拒绝
数据)。排序键 = `(有人在等我 desc, due asc nulls-last)`;WAITING 永不占主列表。

监控成本:event 锚搭 per-person 游标便车(~0);time 锚每日一次 sweep;none 锚
每周一次。WAITING 被新消息解决的判断是 LLM 提案,过 G2 + `ts > waiting.since`
时间门(不许拿旧话当新回复)。

**捕获契约**(Masicampo:计划解除侵入性思维,前提是可验证的信任):
数量守恒断言(候选数==入账数+PARKED 数,违反响亮崩)+ 每轮捕获回执 digest +
覆盖率差集报告(「⚠ 3 人发了消息但不在监控范围:Echo…」——集合减法,零 LLM)。

## 6. 遗忘与生命周期(单一管道)

批判裁决 P0-2,全系统只有一条遗忘管道:

- **performer=owner 的 COMMITTED 永不被系统自动关闭**——只降可见度
  (review_misses≥2 → 进周清扫批次),周清扫**默认归档、owner 勾选保留**
  (方向反转:303 条的病根是默认保留、逐条确认删)。owner 过目即满足契约。
- **performer=对方的跟踪项**允许 TTL 自动降级(时钟到期 → CLOSED_LAPSED,
  brief 报备)。时钟重置的唯一途径:一条新的、过 quote gate 的逐字证据。
  人还在聊别的 ≠ 强化(Schacter transience 的机械化)。
- 时钟全局只有 3 个(批判#17):未应答(work 3 工作日/social 7 天)、待验收
  (requester=对方 7 天 auto_accept;=owner 一键验收)、遗忘(review_misses≥2)。
- **复活**(批判#5):CLOSED_DONE/DECLINED 等墓碑**永死**;CLOSED_LAPSED 凭
  `ts > closed_at` 的新证据进裁决队列;**永不自动复活**。
- **安全阀**(永不自动遗忘):has_money(正则自动置位)、has_contract(LLM 提
  议+owner 确认)、pinned(仅 owner)。安全阀防遗忘,不防带证据的关闭。
- append-only 防 Schacter 的 bias(当前信念重写历史):what 变更只能走
  supersede 链,旧记录冻结;防 suggestibility(自我喂养污染):抽取 prompt 的
  输入只含原始消息,既有账本条目只以 key 哈希参与去重,其文本永不回流。

Schacter 七宗罪对照:transience=TTL 状态机 / absent-mindedness=G10 覆盖守恒 /
blocking=G11 render invariant / misattribution=G1+G3 / suggestibility=
no-self-feeding / bias=append-only / persistence=本节全部。

**Mauss 互惠账:不建**(owner 裁决,2026-08-22,推翻批判#9)。催不催、何时催,
标准是事情对企业的价值与时间压力,不是人情余额 —— 互惠不得影响任何行动或排序。
per-person 履约统计不进入本设计。

## 7. 延展心智交互契约

第一铁律:owner 的每个低摩擦手势都有代码路径写回账本;账本每次变化都能被一个
手势撤销或确认。**手势查表,不经 LLM**(唯一 LLM 通道是自然语言 chat)。

手势表:TickTick 勾选=验收(CLOSED_DONE)/ 删除=dropped(次日 digest 四选一补问
原因,不答=confirmed)/ 挪清单@不是我的=performer 改判+反例入库 / 挪清单@过时了
=LAPSED+时窗反例 / 挪日期=due 更新 / digest 一键(confirm_done/not_mine/stale/
merge_up/wrong_detail/restore/create_persona/mute_sender)。
⚠ 落地前置:验证 TickTick 同步能否读回 move/delete/reschedule 事件(批判#23),
不可行则这三种手势降级为 digest 按钮。

**裁决即训练**(Schank「从失败中重组记忆」,批判#10):Adjudication log 是唯一
失败数据源,**永久保留**(账本可遗忘,裁决日志不遗忘);golden replay 标注集从
它派生。五类更正的回流:closed→闭合短语进代码级 closure-candidate 扫描器
(产出「疑似关闭」一键项,不自动关);not_mine→G1(已是代码门,反例兜底);
stale→G5;too_granular→浮现 cap 与 G9;wrong_detail→G3。

**信任分层**(代码静态表,LLM 不自评风险):
T0 静默(账本写入/游标/owner 手势的执行)| T1 先做后报(渲染新行/遗忘/起草)|
T2 ASK-not-GUESS(发消息/日历邀请/建 Jira——出系统边界)。永远 T2:收件人解析、
缺参数。**信任升级只能由 owner 在周 review 授予**,系统展示近 N 次正确率作依据,
一次严重错误一键升回。

**Review 节奏**:每日 brief ≤90 秒五栏(待裁决/疑似已结束/昨日先做后报/盲点/
删除补问),每栏硬上限 5 条(digest 不能成为第 304 条待办);周 review 是 owner
唯一被要求「思考」的时刻:matter 盘点(定义/合并/结束——只在这里、只由 owner)、
候审区放行、遗忘清单一键 restore(翻案窗口一周)、参数与信任调整、回流摘要
(同类更正连续两周 ≥3 次 = 对应门失效的响亮信号)。

## 8. Matter 注册表

owner 独占定义权。现行清单(2026-08-22 定稿,16 件):Taiv FCC 认证 / HDMI Cert
(Zack 委派 + Echo 约实验室)/ 新 3500 套订单 / Rev5 量产收尾 / DS 平台(唯一
todo=建 epic)/ Chip Cascading / Leap / 导控所项目(含 Chu 报价)/ iTaiga / xEV /
8/28 茂名之行 / 中汽研测试设备(一阶段款未付,has_money)/ 井智科技(与朱桦)/
招聘+孙陈。系统只提名归属和新建议,注册表的增删改只发生在周 review、只由 owner。

## 9. 迁移计划

**存量 303 条**(批判#12,采 CfA 方案,砍 LLM 合并簇):代码重跑 G1/G2/G5,
全过 ∧ 有 matter → 迁为 COMMITTED;任一不过 → CLOSED_LAPSED(reason:
migration_ungated),按 matter 汇总成一次性遗忘清单供 owner 捞回。预期绝大多数
被合法冲掉——存量的 #1/#2 病在迁移这一刻被同一套门清算。

**留下的资产**:quote gate(收紧为 G2 进守卫库)、墓碑+复活(G12)、per-person
游标(事件锚的载体)、tick-to-execute(T2 执行的幂等通道)、R1 写入关卡(扩展为
守卫库宿主)、owner 的 outbound 捕获(已验证:Slack DM 双方/Gmail to:对方/WeChat
me: 行齐全)。

**死掉的**:LLM needs_leo verdict(改派生)、assessment 字段(其功能被状态机
吸收:blocked_on ≈ 球在谁那里 = WAITING 派生态)、`who: me|them`(改 requester/
performer)、`status: overdue`(改派生视图)、按条数取语料(改时间窗)。

## 10. 实施顺序(每阶段独立可验证)

1. **守卫库先行**:G1(speaker)/G2(单消息 quote)/G3(entity)/G5(时间窗)/G6(日期
   复推导)/G10(覆盖守恒)接到**现有**管线上——不动架构,先止血。验证:golden
   replay 上 8 条误归修正 ≥6、U2A8 拒绝、Echo/朱桦落 QUARANTINE。
2. **言语行为层**:单枚举分类 + 中文模糊语表 + frame 单向阀;抽取输出改为
   UtteranceAct(msg_id 绑定)。验证:HEDGE 不再入账。
3. **账本 v2 + 状态机**:Commitment v2、fold(history)、守卫表、303 清算。
   验证:重放全部历史转移无非法边;open 总数落到 matter 清单量级。
4. **浮现派生函数 + 每日 brief**:锚、表面映射、cap、排序。验证:G11 不变量 +
   主列表 ≈ matter 数。
5. **手势通道 + 周 review**:TickTick 事件读回可行性验证 → 手势表或 digest 降级
   方案;Adjudication log;回流管道。
6. **golden replay 进 CI**:60 天冻结语料 + owner 全部历史裁决作回归集;每次改
   prompt 或门必跑;QUARANTINE/REJECTED/PARKED 计数周环比翻倍即报警——
   **门被绕过时系统必须尖叫,不许适应**。

## 11. 评估标准(前瞻记忆科学给的量纲)

- **Miss(漏)**:Echo 类。硬门:真承诺 recall = 100%(回归集 15/15),漏 1 即 fail。
- **False alarm(误报)**:owner 裁决「不是我的/已结束/太细」的比率;目标:主列表
  条目 owner 首见即认可率 ≥80%(当前实测约 20%)。
- **Latency**:承诺发生 → 上表面的时延;闭合信号发生 → 行消失的时延(≤1 tick)。
- 漏斗健康:L0→CANDIDATE 30-40%、L1→EXTRACTABLE 15-25%、铸造 ≈1-3 条/100 消息,
  偏离 ±15pt 即调查。
- owner 的每次裁决自动回灌标注集——**评估集单调增长,系统的成绩单由 owner 的
  真实裁决构成**,不由自评构成。

## 12. 未裁决问题(已决的移入正文)

- ✅ ACK:按对话内容定,不按人(§3,owner 2026-08-22)
- ✅ 互惠账:砍掉,决策只按企业最优(§6,owner 2026-08-22)
1. 周清扫的节奏:周日晚还是周一早?
2. TickTick 手势(挪清单/挪日期/删除)若 API 读不回事件,接受降级为每日简报
   一键按钮吗?(勾选已确认可读回;此问只关其余三种手势)
