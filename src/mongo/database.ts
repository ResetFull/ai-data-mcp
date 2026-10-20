import {
  BSON,
  MongoClient,
  type Db,
  type Document,
  type Filter,
  type OptionalUnlessRequiredId,
  type UpdateFilter,
} from "mongodb";
import { MongoConfigStore } from "./config.js";
import { runWrite } from "../write-policy.js";

export interface MongoPage {
  documents: unknown[];
  has_more: boolean;
}

export class MongoDatabaseManager {
  public constructor(private readonly configStore: MongoConfigStore) {}

  public async listCollections(
    connectionId: string,
    nameContains: string | undefined,
    limit: number,
  ): Promise<MongoPage> {
    return this.withDatabase(connectionId, async (database) => {
      const cursor = database.listCollections({}, { nameOnly: false });
      const documents: Document[] = [];
      for await (const collection of cursor) {
        if (!nameContains || collection.name.toLowerCase().includes(nameContains.toLowerCase())) {
          documents.push(collection);
          if (documents.length > limit) {
            break;
          }
        }
      }
      return page(documents, limit);
    });
  }

  public async find(
    connectionId: string,
    collectionName: string,
    filter: Filter<Document>,
    projection: Document | undefined,
    sort: Document | undefined,
    skip: number,
    limit: number,
    timeoutMs: number,
  ): Promise<MongoPage> {
    return this.withDatabase(connectionId, async (database) => {
      let cursor = database.collection(collectionName)
        .find(filter, { ...(projection ? { projection } : {}), maxTimeMS: timeoutMs })
        .skip(skip)
        .limit(limit + 1);
      if (sort) {
        cursor = cursor.sort(sort);
      }
      return page(await cursor.toArray(), limit);
    });
  }

  public async aggregate(
    connectionId: string,
    collectionName: string,
    pipeline: Document[],
    limit: number,
    timeoutMs: number,
  ): Promise<MongoPage> {
    return this.withDatabase(connectionId, async (database) => page(
      await database.collection(collectionName)
        .aggregate([...pipeline, { $limit: limit + 1 }], { maxTimeMS: timeoutMs })
        .toArray(),
      limit,
    ));
  }

  public async count(
    connectionId: string,
    collectionName: string,
    filter: Filter<Document>,
    timeoutMs: number,
  ): Promise<number> {
    return this.withDatabase(connectionId, async (database) => database.collection(collectionName)
      .countDocuments(filter, { maxTimeMS: timeoutMs }));
  }

  public async insertOne(
    connectionId: string,
    collectionName: string,
    document: OptionalUnlessRequiredId<Document>,
  ): Promise<unknown> {
    return this.withDatabase(connectionId, async (database) => serialize(
      await runWrite(() => database.collection(collectionName).insertOne(document)),
    ));
  }

  public async updateMany(
    connectionId: string,
    collectionName: string,
    filter: Filter<Document>,
    update: UpdateFilter<Document>,
  ): Promise<unknown> {
    return this.withDatabase(connectionId, async (database) => serialize(
      await runWrite(() => database.collection(collectionName).updateMany(filter, update)),
    ));
  }

  public async deleteMany(
    connectionId: string,
    collectionName: string,
    filter: Filter<Document>,
  ): Promise<unknown> {
    return this.withDatabase(connectionId, async (database) => serialize(
      await runWrite(() => database.collection(collectionName).deleteMany(filter)),
    ));
  }

  private async withDatabase<T>(connectionId: string, operation: (database: Db) => Promise<T>): Promise<T> {
    const connection = await this.configStore.getConnection(connectionId);
    const client = new MongoClient(await this.configStore.getUri(connectionId), {
      maxPoolSize: connection.maxPoolSize,
      minPoolSize: 0,
      connectTimeoutMS: connection.connectTimeoutMs,
      serverSelectionTimeoutMS: connection.connectTimeoutMs,
      socketTimeoutMS: 15000,
      retryWrites: false,
    });
    try {
      await client.connect();
      return await operation(client.db(connection.database));
    } finally {
      await client.close();
    }
  }
}

function page(documents: Document[], limit: number): MongoPage {
  return {
    documents: serialize(documents.slice(0, limit)) as unknown[],
    has_more: documents.length > limit,
  };
}

function serialize(value: unknown): unknown {
  return BSON.EJSON.serialize(value, { relaxed: true });
}
