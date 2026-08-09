/** A named profile that session-cycles' assignedTo field references by id, as served by GET /profiles. avatar is a single emoji character. */
export interface Profile {
  readonly id: string;
  readonly name: string;
  readonly createdAt: string;
  readonly avatar: string | null;
}
