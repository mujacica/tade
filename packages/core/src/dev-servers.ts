// Which of the ports an agent's lane listens on are worth a link: the page a
// dev server it started is serving.
//
// The probe (`listeningPorts`, in status) says only that something listens. It
// cannot say whether that something speaks http without connecting to it, and
// nothing here connects, so this is a guess made the narrow way: a port below
// 1024 is the system's, one from 32768 up is where an OS puts a port nobody
// asked for (a harness's own socket, a language server), and a few in between
// are well known for something that is never a page — a database, a broker, a
// debugger. What is left is drawn as `http://localhost:<port>`, which is where
// a browser on this machine finds it whichever local address it was bound to.

/** Below this a port is the system's. */
const LOWEST = 1024

/** From here up a port is one an OS handed out (Linux from 32768, macOS from 49152). */
const HANDED_OUT = 32_768

/** Ports in range that a dev setup listens on often and never serves a page from. */
const NOT_A_PAGE: ReadonlySet<number> = new Set([
  1025, // an SMTP catcher's mail port (its page is elsewhere)
  1433, // SQL Server
  1521, // Oracle
  1883, // MQTT
  2181, // ZooKeeper
  2345, // delve
  3306, // MySQL
  4222, // NATS
  4369, // Erlang's port mapper
  5005, // a JVM's debugger
  5432, // Postgres
  5672, // AMQP
  5678, // debugpy
  6379, // Redis
  6380, // Redis
  9042, // Cassandra
  9092, // Kafka
  9222, // a browser's debugging port
  9229, // Node's inspector
  9230, // Node's inspector
  11211, // memcached
  24678, // Vite's hot-reload socket
  26379, // Redis Sentinel
  27017, // MongoDB
  27018, // MongoDB
  27019, // MongoDB
])

/** Of these ports, the ones a dev server is likely serving a page on: sorted, each once. */
export function devServerPorts(ports: readonly number[]): number[] {
  const kept = ports.filter(
    (port) =>
      Number.isInteger(port) && port >= LOWEST && port < HANDED_OUT && !NOT_A_PAGE.has(port),
  )
  return [...new Set(kept)].sort((a, b) => a - b)
}

/** Where a browser on this machine opens the page a dev server on `port` serves. */
export function devServerUrl(port: number): string {
  return `http://localhost:${port}`
}
