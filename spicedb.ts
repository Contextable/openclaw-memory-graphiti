/**
 * SpiceDB Client Wrapper
 *
 * Wraps @authzed/authzed-node for authorization operations:
 * WriteSchema, WriteRelationships, LookupResources, CheckPermission.
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

  async writeRelationships(tuples: RelationshipTuple[]): Promise<void> {
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
    await this.promises.writeRelationships(request);
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

  // --------------------------------------------------------------------------
  // Permissions
  // --------------------------------------------------------------------------

  async checkPermission(params: {
    resourceType: string;
    resourceId: string;
    permission: string;
    subjectType: string;
    subjectId: string;
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
      consistency: v1.Consistency.create({
        requirement: { oneofKind: "fullyConsistent", fullyConsistent: true },
      }),
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
      consistency: v1.Consistency.create({
        requirement: { oneofKind: "fullyConsistent", fullyConsistent: true },
      }),
    });

    const results = await this.promises.lookupResources(request);
    return results.map((r: { resourceObjectId: string }) => r.resourceObjectId);
  }
}
