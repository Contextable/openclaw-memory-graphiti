/**
 * SpiceDB Client Wrapper
 *
 * Wraps @authzed/authzed-node for authorization operations:
 * WriteSchema, WriteRelationships, DeleteRelationships, BulkImportRelationships,
 * LookupResources, CheckPermission.
 */

import { v1 } from "@authzed/authzed-node";

// ============================================================================
// Types
// ============================================================================

export type SpiceDbConfig = {
  endpoint: string;
  token: string;
  insecure: boolean;
};

export type RelationshipTuple = {
  resourceType: string;
  resourceId: string;
  relation: string;
  subjectType: string;
  subjectId: string;
};

export type ConsistencyMode =
  | { mode: "full" }
  | { mode: "at_least_as_fresh"; token: string }
  | { mode: "minimize_latency" };

// ============================================================================
// Client
// ============================================================================

export class SpiceDbClient {
  private client: ReturnType<typeof v1.NewClient>;
  private promises: ReturnType<typeof v1.NewClient>["promises"];

  constructor(config: SpiceDbConfig) {
    if (config.insecure) {
      this.client = v1.NewClient(
        config.token,
        config.endpoint,
        v1.ClientSecurity.INSECURE_LOCALHOST_ALLOWED,
      );
    } else {
      this.client = v1.NewClient(config.token, config.endpoint);
    }
    this.promises = this.client.promises;
  }

  // --------------------------------------------------------------------------
  // Schema
  // --------------------------------------------------------------------------

  async writeSchema(schema: string): Promise<void> {
    const request = v1.WriteSchemaRequest.create({ schema });
    await this.promises.writeSchema(request);
  }

  async readSchema(): Promise<string> {
    const request = v1.ReadSchemaRequest.create({});
    const response = await this.promises.readSchema(request);
    return response.schemaText;
  }

  // --------------------------------------------------------------------------
  // Relationships
  // --------------------------------------------------------------------------

  async writeRelationships(tuples: RelationshipTuple[]): Promise<string | undefined> {
    const updates = tuples.map((t) =>
      v1.RelationshipUpdate.create({
        operation: v1.RelationshipUpdate_Operation.TOUCH,
        relationship: v1.Relationship.create({
          resource: v1.ObjectReference.create({
            objectType: t.resourceType,
            objectId: t.resourceId,
          }),
          relation: t.relation,
          subject: v1.SubjectReference.create({
            object: v1.ObjectReference.create({
              objectType: t.subjectType,
              objectId: t.subjectId,
            }),
          }),
        }),
      }),
    );

    const request = v1.WriteRelationshipsRequest.create({ updates });
    const response = await this.promises.writeRelationships(request);
    return response.writtenAt?.token;
  }

  async deleteRelationships(tuples: RelationshipTuple[]): Promise<void> {
    const updates = tuples.map((t) =>
      v1.RelationshipUpdate.create({
        operation: v1.RelationshipUpdate_Operation.DELETE,
        relationship: v1.Relationship.create({
          resource: v1.ObjectReference.create({
            objectType: t.resourceType,
            objectId: t.resourceId,
          }),
          relation: t.relation,
          subject: v1.SubjectReference.create({
            object: v1.ObjectReference.create({
              objectType: t.subjectType,
              objectId: t.subjectId,
            }),
          }),
        }),
      }),
    );

    const request = v1.WriteRelationshipsRequest.create({ updates });
    await this.promises.writeRelationships(request);
  }

  async deleteRelationshipsByFilter(params: {
    resourceType: string;
    resourceId: string;
    relation?: string;
  }): Promise<string | undefined> {
    const request = v1.DeleteRelationshipsRequest.create({
      relationshipFilter: v1.RelationshipFilter.create({
        resourceType: params.resourceType,
        optionalResourceId: params.resourceId,
        ...(params.relation ? { optionalRelation: params.relation } : {}),
      }),
    });

    const response = await this.promises.deleteRelationships(request);
    return response.deletedAt?.token;
  }

  // --------------------------------------------------------------------------
  // Bulk Import
  // --------------------------------------------------------------------------

  private toRelationship(t: RelationshipTuple) {
    return v1.Relationship.create({
      resource: v1.ObjectReference.create({
        objectType: t.resourceType,
        objectId: t.resourceId,
      }),
      relation: t.relation,
      subject: v1.SubjectReference.create({
        object: v1.ObjectReference.create({
          objectType: t.subjectType,
          objectId: t.subjectId,
        }),
      }),
    });
  }

  /**
   * Bulk import relationships using the streaming ImportBulkRelationships RPC.
   * More efficient than individual writeRelationships calls for large batches.
   * Falls back to batched writeRelationships if the streaming RPC is unavailable.
   */
  async bulkImportRelationships(
    tuples: RelationshipTuple[],
    batchSize = 1000,
  ): Promise<number> {
    if (tuples.length === 0) return 0;

    // Try streaming bulk import first
    if (typeof this.promises.bulkImportRelationships === "function") {
      return this.bulkImportViaStream(tuples, batchSize);
    }

    // Fallback: batched writeRelationships
    return this.bulkImportViaWrite(tuples, batchSize);
  }

  private bulkImportViaStream(
    tuples: RelationshipTuple[],
    batchSize: number,
  ): Promise<number> {
    return new Promise((resolve, reject) => {
      const stream = this.promises.bulkImportRelationships(
        (err: Error | null, response?: { numLoaded?: string }) => {
          if (err) reject(err);
          else resolve(Number(response?.numLoaded ?? tuples.length));
        },
      );

      stream.on("error", (err: Error) => {
        reject(err);
      });

      for (let i = 0; i < tuples.length; i += batchSize) {
        const chunk = tuples.slice(i, i + batchSize);
        stream.write(
          v1.BulkImportRelationshipsRequest.create({
            relationships: chunk.map((t) => this.toRelationship(t)),
          }),
        );
      }

      stream.end();
    });
  }

  private async bulkImportViaWrite(
    tuples: RelationshipTuple[],
    batchSize: number,
  ): Promise<number> {
    let total = 0;
    for (let i = 0; i < tuples.length; i += batchSize) {
      const chunk = tuples.slice(i, i + batchSize);
      await this.writeRelationships(chunk);
      total += chunk.length;
    }
    return total;
  }

  // --------------------------------------------------------------------------
  // Read Relationships
  // --------------------------------------------------------------------------

  /**
   * Read relationships matching a filter. Returns all tuples that match the
   * specified resource type, optional resource ID, optional relation, and
   * optional subject filter. Used by the cleanup command to find which
   * Graphiti episodes have SpiceDB authorization relationships.
   */
  async readRelationships(params: {
    resourceType: string;
    resourceId?: string;
    relation?: string;
    subjectType?: string;
    subjectId?: string;
    consistency?: ConsistencyMode;
  }): Promise<RelationshipTuple[]> {
    const filterFields: Record<string, unknown> = {
      resourceType: params.resourceType,
    };
    if (params.resourceId) {
      filterFields.optionalResourceId = params.resourceId;
    }
    if (params.relation) {
      filterFields.optionalRelation = params.relation;
    }
    if (params.subjectType) {
      const subjectFilter: Record<string, unknown> = {
        subjectType: params.subjectType,
      };
      if (params.subjectId) {
        subjectFilter.optionalSubjectId = params.subjectId;
      }
      filterFields.optionalSubjectFilter = v1.SubjectFilter.create(subjectFilter);
    }

    const request = v1.ReadRelationshipsRequest.create({
      relationshipFilter: v1.RelationshipFilter.create(filterFields),
      consistency: this.buildConsistency(params.consistency),
    });

    const results = await this.promises.readRelationships(request);
    const tuples: RelationshipTuple[] = [];
    for (const r of results) {
      const rel = r.relationship;
      if (!rel?.resource || !rel.subject?.object) continue;
      tuples.push({
        resourceType: rel.resource.objectType,
        resourceId: rel.resource.objectId,
        relation: rel.relation,
        subjectType: rel.subject.object.objectType,
        subjectId: rel.subject.object.objectId,
      });
    }
    return tuples;
  }

  // --------------------------------------------------------------------------
  // Permissions
  // --------------------------------------------------------------------------

  private buildConsistency(mode?: ConsistencyMode) {
    if (!mode || mode.mode === "minimize_latency") {
      return v1.Consistency.create({
        requirement: { oneofKind: "minimizeLatency", minimizeLatency: true },
      });
    }
    if (mode.mode === "at_least_as_fresh") {
      return v1.Consistency.create({
        requirement: {
          oneofKind: "atLeastAsFresh",
          atLeastAsFresh: v1.ZedToken.create({ token: mode.token }),
        },
      });
    }
    return v1.Consistency.create({
      requirement: { oneofKind: "fullyConsistent", fullyConsistent: true },
    });
  }

  async checkPermission(params: {
    resourceType: string;
    resourceId: string;
    permission: string;
    subjectType: string;
    subjectId: string;
    consistency?: ConsistencyMode;
  }): Promise<boolean> {
    const request = v1.CheckPermissionRequest.create({
      resource: v1.ObjectReference.create({
        objectType: params.resourceType,
        objectId: params.resourceId,
      }),
      permission: params.permission,
      subject: v1.SubjectReference.create({
        object: v1.ObjectReference.create({
          objectType: params.subjectType,
          objectId: params.subjectId,
        }),
      }),
      consistency: this.buildConsistency(params.consistency),
    });

    const response = await this.promises.checkPermission(request);
    return (
      response.permissionship ===
      v1.CheckPermissionResponse_Permissionship.HAS_PERMISSION
    );
  }

  async lookupResources(params: {
    resourceType: string;
    permission: string;
    subjectType: string;
    subjectId: string;
    consistency?: ConsistencyMode;
  }): Promise<string[]> {
    const request = v1.LookupResourcesRequest.create({
      resourceObjectType: params.resourceType,
      permission: params.permission,
      subject: v1.SubjectReference.create({
        object: v1.ObjectReference.create({
          objectType: params.subjectType,
          objectId: params.subjectId,
        }),
      }),
      consistency: this.buildConsistency(params.consistency),
    });

    const results = await this.promises.lookupResources(request);
    return results.map((r: { resourceObjectId: string }) => r.resourceObjectId);
  }
}
