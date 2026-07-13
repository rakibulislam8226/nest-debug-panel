import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(AppModule);
  const port = Number(process.env.PORT ?? 3000);
  await app.listen(port);
  console.log(`
  Example app:     http://localhost:${port}
  Debug dashboard: http://localhost:${port}/__debug

  Try:
    curl http://localhost:${port}/users
    curl http://localhost:${port}/users/1
    curl -X POST http://localhost:${port}/users -H 'content-type: application/json' -d '{"name":"Joan","password":"s3cret"}'
    curl http://localhost:${port}/n-plus-one   # N+1 detection demo
    curl http://localhost:${port}/slow         # slow query + slow request
    curl http://localhost:${port}/external     # outgoing HTTP capture
    curl http://localhost:${port}/boom         # exception capture
  `);
}

void bootstrap();
