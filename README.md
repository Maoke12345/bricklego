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
