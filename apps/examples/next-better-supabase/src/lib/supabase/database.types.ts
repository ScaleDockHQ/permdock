export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[]

export type Database = {
  // Allows to automatically instantiate createClient with right options
  // instead of createClient<Database, { PostgrestVersion: 'XX' }>(URL, KEY)
  __InternalSupabase: {
    PostgrestVersion: "13"
  }
  public: {
    Tables: {
      contacts: {
        Row: {
          customer_id: string
          id: string
          name: string
          organization_id: string
          user_id: string | null
        }
        Insert: {
          customer_id: string
          id: string
          name: string
          organization_id: string
          user_id?: string | null
        }
        Update: {
          customer_id?: string
          id?: string
          name?: string
          organization_id?: string
          user_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "contacts_customer_id_fkey"
            columns: ["customer_id"]
            isOneToOne: false
            referencedRelation: "customers"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "contacts_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
        ]
      }
      customers: {
        Row: {
          id: string
          name: string
          organization_id: string
        }
        Insert: {
          id: string
          name: string
          organization_id: string
        }
        Update: {
          id?: string
          name?: string
          organization_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "customers_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
        ]
      }
      datetime_preferences: {
        Row: {
          hour_cycle: string
          time_zone: string
          user_id: string
        }
        Insert: {
          hour_cycle: string
          time_zone: string
          user_id: string
        }
        Update: {
          hour_cycle?: string
          time_zone?: string
          user_id?: string
        }
        Relationships: []
      }
      memberships: {
        Row: {
          role: string
          scope: string
          scope_id: string
          user_id: string
        }
        Insert: {
          role: string
          scope: string
          scope_id: string
          user_id: string
        }
        Update: {
          role?: string
          scope?: string
          scope_id?: string
          user_id?: string
        }
        Relationships: []
      }
      organization_features: {
        Row: {
          feature: string
          organization_id: string
        }
        Insert: {
          feature: string
          organization_id: string
        }
        Update: {
          feature?: string
          organization_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "organization_features_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
        ]
      }
      organizations: {
        Row: {
          id: string
          name: string
          slug: string
        }
        Insert: {
          id: string
          name: string
          slug: string
        }
        Update: {
          id?: string
          name?: string
          slug?: string
        }
        Relationships: []
      }
      permdock_authz_version: {
        Row: {
          user_id: string
          version: number
        }
        Insert: {
          user_id: string
          version?: number
        }
        Update: {
          user_id?: string
          version?: number
        }
        Relationships: []
      }
      quotes: {
        Row: {
          amount: number
          customer_id: string
          id: string
          organization_id: string
          title: string
        }
        Insert: {
          amount: number
          customer_id: string
          id: string
          organization_id: string
          title: string
        }
        Update: {
          amount?: number
          customer_id?: string
          id?: string
          organization_id?: string
          title?: string
        }
        Relationships: [
          {
            foreignKeyName: "quotes_customer_id_fkey"
            columns: ["customer_id"]
            isOneToOne: false
            referencedRelation: "customers"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "quotes_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
        ]
      }
      role_permissions: {
        Row: {
          effect: string
          grant_key: string
          permission: string
          role: string
          scope: string
        }
        Insert: {
          effect?: string
          grant_key: string
          permission: string
          role: string
          scope: string
        }
        Update: {
          effect?: string
          grant_key?: string
          permission?: string
          role?: string
          scope?: string
        }
        Relationships: []
      }
      staff: {
        Row: {
          id: string
          name: string
          organization_id: string
          title: string
          user_id: string
        }
        Insert: {
          id: string
          name: string
          organization_id: string
          title: string
          user_id: string
        }
        Update: {
          id?: string
          name?: string
          organization_id?: string
          title?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "staff_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
        ]
      }
      user_roles: {
        Row: {
          role: string
          user_id: string
        }
        Insert: {
          role: string
          user_id: string
        }
        Update: {
          role?: string
          user_id?: string
        }
        Relationships: []
      }
    }
    Views: {
      [_ in never]: never
    }
    Functions: {
      custom_access_token_hook: { Args: { event: Json }; Returns: Json }
      datetime_preference_claims: { Args: { p_user_id: string }; Returns: Json }
      feature_claims: { Args: { p_user_id: string }; Returns: Json }
      member_customer_ids: {
        Args: Record<PropertyKey, never>
        Returns: string[]
      }
      member_customer_ids_for: { Args: { p_user: string }; Returns: string[] }
      member_organization_ids: {
        Args: Record<PropertyKey, never>
        Returns: string[]
      }
      member_organization_ids_for: {
        Args: { p_user: string }
        Returns: string[]
      }
      permdock_has: { Args: { p_grant: string }; Returns: boolean }
      permitted_customer_ids: { Args: { p_grant: string }; Returns: string[] }
      permitted_organization_ids: {
        Args: { p_grant: string }
        Returns: string[]
      }
    }
    Enums: {
      [_ in never]: never
    }
    CompositeTypes: {
      [_ in never]: never
    }
  }
}

type DatabaseWithoutInternals = Omit<Database, "__InternalSupabase">

type DefaultSchema = DatabaseWithoutInternals[Extract<keyof Database, "public">]

export type Tables<
  DefaultSchemaTableNameOrOptions extends
    | keyof (DefaultSchema["Tables"] & DefaultSchema["Views"])
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends (DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
        DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])
    : never) = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
      DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])[TableName] extends {
      Row: infer R
    }
    ? R
    : never
  : DefaultSchemaTableNameOrOptions extends keyof (DefaultSchema["Tables"] &
        DefaultSchema["Views"])
    ? (DefaultSchema["Tables"] &
        DefaultSchema["Views"])[DefaultSchemaTableNameOrOptions] extends {
        Row: infer R
      }
      ? R
      : never
    : never

export type TablesInsert<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends (DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never) = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Insert: infer I
    }
    ? I
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Insert: infer I
      }
      ? I
      : never
    : never

export type TablesUpdate<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends (DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never) = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Update: infer U
    }
    ? U
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Update: infer U
      }
      ? U
      : never
    : never

export type Enums<
  DefaultSchemaEnumNameOrOptions extends
    | keyof DefaultSchema["Enums"]
    | { schema: keyof DatabaseWithoutInternals },
  EnumName extends (DefaultSchemaEnumNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"]
    : never) = never,
> = DefaultSchemaEnumNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"][EnumName]
  : DefaultSchemaEnumNameOrOptions extends keyof DefaultSchema["Enums"]
    ? DefaultSchema["Enums"][DefaultSchemaEnumNameOrOptions]
    : never

export type CompositeTypes<
  PublicCompositeTypeNameOrOptions extends
    | keyof DefaultSchema["CompositeTypes"]
    | { schema: keyof DatabaseWithoutInternals },
  CompositeTypeName extends (PublicCompositeTypeNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"]
    : never) = never,
> = PublicCompositeTypeNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"][CompositeTypeName]
  : PublicCompositeTypeNameOrOptions extends keyof DefaultSchema["CompositeTypes"]
    ? DefaultSchema["CompositeTypes"][PublicCompositeTypeNameOrOptions]
    : never

export const Constants = {
  public: {
    Enums: {},
  },
} as const
