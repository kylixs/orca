// Real git demo repositories seeded by the local environment reseed.
import fs from 'node:fs'
import path from 'node:path'
import { run } from './local-env-daemon-control.mjs'

export const DEMO_REPOS = {
  'demo-app': {
    feature: 'feature/refund-api',
    commits: [
      ['init: 初始化 demo-app 仓库', [['README.md', '# demo-app\n\n支付结算演示项目。\n']]],
      [
        'docs: 补充本地运行说明',
        [
          [
            'README.md',
            '# demo-app\n\n支付结算演示项目。\n\n## 快速开始\n\n```bash\nnode src/server.js\n```\n'
          ]
        ]
      ],
      [
        'feat: 订单创建与支付回调',
        [
          [
            'src/server.js',
            "import { createOrder } from './order.js'\n\nexport function start() {\n  return createOrder({ amount: 100 })\n}\n"
          ],
          [
            'src/order.js',
            "export function createOrder(input) {\n  return { id: 'ord_1', status: 'created', ...input }\n}\n"
          ],
          [
            'src/webhook.js',
            'export function handleWebhook(event) {\n  return { received: event.type, ok: true }\n}\n'
          ]
        ]
      ],
      [
        'docs: 支付链路设计说明',
        [['docs/design.md', '# 支付链路设计\n\n1. 创建订单\n2. 调用支付网关\n3. 回调校验签名\n']]
      ]
    ],
    featureCommit: [
      'feat: 退款申请接口',
      [
        [
          'src/refund.js',
          "export function requestRefund(orderId, amount) {\n  return { orderId, amount, status: 'refund_pending' }\n}\n"
        ]
      ]
    ]
  },
  'zhangsan-demo': {
    feature: 'feature/export-html',
    commits: [
      [
        'init: 初始化 zhangsan-demo 仓库',
        [['README.md', '# zhangsan-demo\n\n研发自助创建的演示项目。\n']]
      ],
      [
        'docs: 使用说明',
        [
          [
            'README.md',
            '# zhangsan-demo\n\n研发自助创建的演示项目。\n\n## 用法\n\n```bash\nnode src/render.js\n```\n'
          ]
        ]
      ],
      [
        'feat: 文本解析与数值聚合',
        [
          [
            'src/parse.js',
            'export function parse(input) {\n  return String(input).trim().split(/\\s+/)\n}\n'
          ],
          [
            'src/aggregate.js',
            'export function aggregate(rows) {\n  return rows.reduce((sum, row) => sum + row, 0)\n}\n'
          ]
        ]
      ],
      [
        'feat: 列表渲染',
        [
          [
            'src/render.js',
            "export function render(rows) {\n  return rows.map((row) => '<li>' + row + '</li>').join('')\n}\n"
          ]
        ]
      ]
    ],
    featureCommit: [
      'feat: 导出 HTML',
      [
        [
          'src/export.js',
          "export function exportHtml(rows) {\n  return '<ul>' + rows.map((row) => '<li>' + row + '</li>').join('') + '</ul>'\n}\n"
        ]
      ]
    ]
  }
}

const git = (cwd, args) => run('git', args, { cwd })

function writeProjectFile(dir, rel, content) {
  const file = path.join(dir, rel)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, content)
}

function commitAll(dir, message) {
  git(dir, ['add', '-A'])
  git(dir, ['commit', '-m', message])
}

/** Creates the repo only when absent; an existing repo is never touched. */
export function ensureRepo(dir, spec) {
  if (fs.existsSync(path.join(dir, '.git'))) {
    return false
  }
  fs.mkdirSync(dir, { recursive: true })
  git(dir, ['init', '-b', 'main'])
  git(dir, ['config', 'user.name', 'Orca Demo'])
  git(dir, ['config', 'user.email', 'demo@orca.local'])
  for (const [message, files] of spec.commits) {
    for (const [rel, content] of files) {
      writeProjectFile(dir, rel, content)
    }
    commitAll(dir, message)
  }
  git(dir, ['checkout', '-b', spec.feature])
  for (const [rel, content] of spec.featureCommit[1]) {
    writeProjectFile(dir, rel, content)
  }
  commitAll(dir, spec.featureCommit[0])
  git(dir, ['checkout', 'main'])
  return true
}

export function repoSummary(dir) {
  return {
    commits: Number(git(dir, ['rev-list', '--count', '--all'])),
    branches: git(dir, ['branch', '--format=%(refname:short)']).split('\n').filter(Boolean).sort()
  }
}
