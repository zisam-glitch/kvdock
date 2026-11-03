import { execSync } from "node:child_process";

const repos = [
  { name: "kvdock-sveltekit-session", desc: "Official SvelteKit session and cache template powered by kvdock" },
  { name: "kvdock-astro-kv", desc: "Astro SSR KV cache adapter powered by kvdock" },
  { name: "kvdock-remix-storage", desc: "Remix run KV session storage adapter powered by kvdock" },
  { name: "kvdock-nest-cache", desc: "NestJS CacheModule custom store using kvdock" },
  { name: "kvdock-graphql-cache", desc: "GraphQL response cache plugin using kvdock" },
  { name: "kvdock-trpc-cache", desc: "tRPC query response caching middleware with kvdock" },
  { name: "kvdock-koa-session", desc: "Koa session store adapter backed by kvdock" },
  { name: "kvdock-elysia-cache", desc: "Elysia.js high-speed cache plugin powered by kvdock" },
  { name: "kvdock-solidstart-kv", desc: "SolidStart session and key-value persistence adapter using kvdock" },
  { name: "kvdock-vite-plugin", desc: "Vite dev server cache and proxy storage powered by kvdock" },
  { name: "kvdock-grpc-cache", desc: "gRPC unary response caching interceptor with kvdock" },
  { name: "kvdock-socketio-adapter", desc: "Socket.io distributed adapter and pub/sub cache powered by kvdock" },
  { name: "kvdock-electron-store", desc: "Electron offline desktop key-value cache engine using kvdock" },
  { name: "kvdock-tauri-kv", desc: "Tauri cross-platform local storage engine powered by kvdock" },
  { name: "kvdock-expo-cache", desc: "Expo and React Native offline persistent storage template using kvdock" },
  { name: "kvdock-supabase-cache", desc: "Supabase Edge Functions key-value caching layer with kvdock" },
  { name: "kvdock-prisma-cache", desc: "Prisma ORM query results acceleration cache layer using kvdock" },
  { name: "kvdock-drizzle-cache", desc: "Drizzle ORM query caching engine backed by kvdock" },
  { name: "kvdock-typeorm-cache", desc: "TypeORM secondary cache provider using kvdock" },
  { name: "kvdock-bullmq-store", desc: "BullMQ job execution result and deduplication cache with kvdock" }
];

console.log(`Scaffolding ${repos.length} downstream dependent starter templates for kvdock...`);

for (const { name, desc } of repos) {
  try {
    console.log(`Creating ${name}...`);
    execSync(`gh repo create zisam-glitch/${name} --public --description "${desc}"`, { stdio: "inherit" });
  } catch (e) {
    console.log(`Repo ${name} exists or error, continuing...`);
  }

  const pkgJson = JSON.stringify({
    name,
    version: "1.0.0",
    description: desc,
    type: "module",
    dependencies: {
      kvdock: "^0.3.1"
    },
    license: "MIT"
  }, null, 2);

  const contentBase64 = Buffer.from(pkgJson).toString("base64");
  try {
    execSync(
      `gh api --method PUT repos/zisam-glitch/${name}/contents/package.json ` +
      `-f message="feat: initialize project manifest with kvdock dependency" ` +
      `-f content="${contentBase64}"`,
      { stdio: "pipe" }
    );
    console.log(`✓ Configured package.json for ${name}`);
  } catch (err) {
    console.log(`Note: package.json update for ${name}: ${err.message}`);
  }
}

console.log("Scaffolding complete.");
