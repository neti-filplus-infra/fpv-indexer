import { NestFactory, Reflector } from '@nestjs/core';
import { DocumentBuilder, OpenAPIObject, SwaggerModule } from '@nestjs/swagger';
import 'dotenv/config';
import { AppModule, ObserveInstrument } from './app.module';
import { packageSemver } from './lib/constants';
import './polyfill';
import {
  StandardSchemaSerializerInterceptor,
  StandardSchemaValidationPipe,
} from '@nestjs/common';

const methods = [
  'get',
  'put',
  'post',
  'delete',
  'options',
  'head',
  'patch',
  'trace',
] as const;

function promoteParameterDescriptions(document: OpenAPIObject) {
  for (const pathItem of Object.values(document.paths)) {
    if (!pathItem || '$ref' in pathItem) continue;

    for (const method of methods) {
      const operation = pathItem[method];
      if (!operation) continue;

      for (const parameter of operation.parameters ?? []) {
        if ('$ref' in parameter || !parameter.schema) continue;
        const schema = parameter.schema;

        if ('$ref' in schema) continue;

        if (!parameter.description && typeof schema.description === 'string') {
          parameter.description = schema.description;
        }
      }
    }
  }

  return document;
}

async function bootstrap() {
  const app = await NestFactory.create(AppModule, {
    cors: true,
    instrument: ObserveInstrument,
  });

  app.useGlobalInterceptors(
    new StandardSchemaSerializerInterceptor(app.get(Reflector)),
  );
  app.useGlobalPipes(new StandardSchemaValidationPipe());

  // Swagger
  const config = new DocumentBuilder()
    .setTitle('FPV Indexer API')
    .setDescription(
      'Documentation of Filecoin Pay Volume Indexer RESTful endpoint. Indexer based on FIP-0118.',
    )
    .setVersion(packageSemver ? packageSemver.toString() : '0.0.1')
    .build();

  const documentFactory = () => {
    return promoteParameterDescriptions(
      SwaggerModule.createDocument(app, config),
    );
  };

  SwaggerModule.setup('', app, documentFactory);

  await app.listen(process.env.PORT ?? 3000);
}

void bootstrap();
