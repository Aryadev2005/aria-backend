import 'dotenv/config'
console.log('1. dotenv loaded')

console.log('2. loading ./src/app...')
import { buildApp } from './src/app'
console.log('3. app loaded')

console.log('4. loading logger...')
import { logger } from './src/utils/logger'
console.log('5. logger loaded')

console.log('6. loading database...')
import { connectDB } from './src/config/database'
console.log('7. database loaded')

console.log('8. loading redis...')
import { connectRedis } from './src/config/redis'
console.log('9. redis loaded')

console.log('10. loading firebase...')
import { initFirebase } from './src/config/firebase'
console.log('11. firebase loaded')

console.log('12. loading queue...')
import { initQueues, scheduleRecurringJobs, cleanupQueues } from './src/config/queue'
console.log('13. queue loaded')

console.log('14. loading workers...')
import { startAllWorkers, stopAllWorkers } from './src/workers'
console.log('15. workers loaded')

console.log('ALL IMPORTS OK')
process.exit(0)
