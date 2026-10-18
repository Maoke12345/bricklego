# 砖语 BrickStudio

上传一张照片，写一句话，得到一个真能搭出来的乐高模型：可以拖着转，可以一层层回放搭建过程，附带零件清单。
搭模型的是 BrickAgent 那一套环境（真实 LDraw 零件、碰撞检测、PyBullet 稳定性检查），驱动它的是跑在容器里的
Claude Code（Opus 5.5，走 LiteLLM 代理）。

## 跑起来

```sh
python3 server.py            # http://127.0.0.1:8787
```

`.env` 里需要 `LITE_LLM_KEY`、`LITE_LLM_URL`、`AGENT_MODEL`，和 brickbench-run 用的是同一份。
需要先有两个镜像：`brickagent`（官方环境）和 `brickagent-claude`（加上 Claude Code CLI）。

## 一次生成都发生了什么

1. 浏览器把照片缩到长边 1536 的 JPEG，和文字一起发给 `POST /api/jobs`。
2. 后端用 BrickAgent 自己的模板渲染提示词（`scripts/prompt.py`），再接上一段产品侧的交代：
   参考照片在 `/work/reference.jpg`，边搭边渲染，最后写 `card.json`，用中文回话。
3. Claude Code 在 `brickagent-claude` 容器里跑，`/work` 是它唯一可写的地方，禁网（WebSearch/WebFetch/curl/wget）。
   它每写一张 PNG，页面几秒内就能看到。
4. 结束后在容器里依次跑官方的 `verify.py`（零件数、碰撞、稳定性）和 `container/export_model.py`
   （把引用到的 LDraw 零件全部嵌进 MPD，再统计零件清单）。
5. 页面载入这份自包含的 MPD，按零件底面高度分层做搭建回放。

后续在对话框里继续说（"把屋顶换成红色"），用的是同一个 `/work` 和同一个会话（`claude --continue`）。

## 文件

### P3 首页封面概念

`web/cover-concept.html` 保留最初获认可的蒙德里安封面独立视觉稿。正式页面封面在 `web/index.html`，样式在 `web/cover.css`。红色 “Starting a project”、黄色 “Your model”、蓝色 “Model history” 积木点击后分别进入照片创作、模型结果和历史区域；三块积木都有向前推出的效果。后面仍是已有的生成状态、3D 查看器、模型信息和零件清单。

封面文字统一使用圆厚字形，红、黄、蓝、黑四块砖上的文字通过与砖面相配的高光和阴影表现浅浮雕，具体样式在 `web/cover-lettering.css`。工作台 BUILD 中间有六块红、黄、蓝色 2×3 小积木沿轻弧线缓慢浮动，叠在字的前面、手的后面；右手拿着黄色积木。样式在 `web/gesture-flow.css`；减少动态效果的系统设置会停用动画。右手图片 `web/gesture-hands-yellow.png` 由原有手部素材使用图像编辑工具局部改色，只修改手中积木并保留透明背景。

封面新增黑色 “Showcase” 积木，点击进入封面与 BrickStudio 之间的展示区。这里有九件静态参考作品：八件从 [BrickAgent 官方仓库的 BrickBench teaser](https://github.com/kulits/BrickAgent/blob/master/docs/images/teaser_mosaic.avif) 中挑选，以 CSS 定位展示原图中的单个模型；来源项目采用 MIT 许可，许可文本见 `references/BrickAgent/LICENSE`。建筑模型来自 Said Sürücü 的 [Ayasofya custom model](https://github.com/saidsurucu/lego-hagia-sophia)，原渲染图转为本地 WebP 以加快加载，并按原项目说明以 CC BY 4.0 署名。九件都不是本站根据用户照片新生成的结果。进入展示区时，图片分层快速落下并拼合；减少动态效果的系统设置会关闭动画。

模型成功载入后，历史区会在**当前浏览器**保存任务 ID、名称、零件数、检查状态及该任务的渲染图路径，不复制私人照片或 MPD。历史区采用可翻页的说明书式模型册，每页展示一件模型，最近完成的排在第一页；这只是档案展示，不提供逐块搭建步骤。点击“Open 3D model”会先确认原始任务仍在当前服务，再用现有 `?job=<id>` 恢复它。历史目录最多保留 30 件；浏览器数据被清除或服务端任务文件被删除后，作品不能从此目录恢复。静态页面预览不会生成模型，因此真实历史区显示空状态。

工作台、结果区、展示区和历史区统一为乳白色调，首页蒙德里安封面保留原设计。工作台与结果区的内容底层有少量低对比度的蒙德里安式断续细线，样式在 `web/mondrian-background.css`。可打开 `web/history-book-preview.html` 查看模型册的**静态版式样例**和翻页、无图片状态；样例建筑图有单独署名，不属于用户历史。真实页面仍只读取当前浏览器里确实完成的模型。

只看页面布局时，可在仓库根目录运行 `python3 -m http.server 8788 --bind 127.0.0.1 --directory web`，打开 `http://127.0.0.1:8788/` 或 `http://127.0.0.1:8788/history-book-preview.html`。这个静态预览没有生成 API；真实生成需按上方环境要求运行 `server.py`。

| 路径 | 作用 |
| --- | --- |
| `server.py` | 页面、任务接口、SSE 实时转播 |
| `pipeline.py` | 提示词拼装、容器调用、事件翻译、校验与打包 |
| `container/export_model.py` | 在容器里跑：自包含 MPD + 零件清单 |
| `web/index.html` `web/app.js` | 产品页面：取景、对话、回放、清单 |
| `web/classic.js` | 那套"经典版"画法：天光加主光、零件间留细缝、分层回放 |
| `web/vendor/` | BrickAgent 的 viewer.js 和 three.js 的 LDrawLoader（MIT），以及 three.js 本体 |
| `jobs/<id>/` | 每次对话：`work/`（agent 的工作目录）、`packed.mpd`、`manifest.json`、`events.jsonl` |

`jobs/demo-knight` 是 2026-10-17 用 Opus 5.5 跑出来的第一个模型（黑骑士，126 件），
打开页面时会自动接上，可以直接拖着看。

## 已知的边界

- 一个模型大概十几分钟、两三美元；"大型套装"那一档会更久。
- 判分（VQA/ELO）没有做：那需要 GPU，这台机器上没有。页面上的"已通过检查"指的是 `verify.py` 的结论。
- 服务只绑在 127.0.0.1，没有账号体系；任何能访问这个端口的人都能看到所有任务。
