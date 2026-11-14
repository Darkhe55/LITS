/**
 * LITS 四格骨墙入口
 */

import './core/styles.css'
import './game/lits.css'
import { createApp } from './core/app'
import { adapter } from './game/adapter'

const root = document.querySelector<HTMLElement>('#app')
if (!root) throw new Error('no #app')

createApp(root, adapter)
