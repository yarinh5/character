export type Json = string | number | boolean | null | { [key: string]: Json | undefined } | Json[];

export type Database = {
  graphql_public: {
    Tables: {
      [_ in never]: never;
    };
    Views: {
      [_ in never]: never;
    };
    Functions: {
      graphql: {
        Args: {
          extensions?: Json;
          operationName?: string;
          query?: string;
          variables?: Json;
        };
        Returns: Json;
      };
    };
    Enums: {
      [_ in never]: never;
    };
    CompositeTypes: {
      [_ in never]: never;
    };
  };
  public: {
    Tables: {
      analytics_events: {
        Row: {
          actor_user_id: string | null;
          character_id: string | null;
          conversation_id: string | null;
          created_at: string;
          event_name: string;
          id: string;
          metadata: Json;
          operator_id: string | null;
          role: Database["public"]["Enums"]["app_role"] | null;
        };
        Insert: {
          actor_user_id?: string | null;
          character_id?: string | null;
          conversation_id?: string | null;
          created_at?: string;
          event_name: string;
          id?: string;
          metadata?: Json;
          operator_id?: string | null;
          role?: Database["public"]["Enums"]["app_role"] | null;
        };
        Update: {
          actor_user_id?: string | null;
          character_id?: string | null;
          conversation_id?: string | null;
          created_at?: string;
          event_name?: string;
          id?: string;
          metadata?: Json;
          operator_id?: string | null;
          role?: Database["public"]["Enums"]["app_role"] | null;
        };
        Relationships: [
          {
            foreignKeyName: "analytics_events_character_id_fkey";
            columns: ["character_id"];
            isOneToOne: false;
            referencedRelation: "characters";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "analytics_events_conversation_id_fkey";
            columns: ["conversation_id"];
            isOneToOne: false;
            referencedRelation: "conversations";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "analytics_events_operator_id_fkey";
            columns: ["operator_id"];
            isOneToOne: false;
            referencedRelation: "operators";
            referencedColumns: ["id"];
          },
        ];
      };
      audit_logs: {
        Row: {
          action: string;
          actor_user_id: string | null;
          created_at: string;
          entity_id: string | null;
          entity_type: string | null;
          id: string;
          metadata: Json | null;
        };
        Insert: {
          action: string;
          actor_user_id?: string | null;
          created_at?: string;
          entity_id?: string | null;
          entity_type?: string | null;
          id?: string;
          metadata?: Json | null;
        };
        Update: {
          action?: string;
          actor_user_id?: string | null;
          created_at?: string;
          entity_id?: string | null;
          entity_type?: string | null;
          id?: string;
          metadata?: Json | null;
        };
        Relationships: [];
      };
      character_media_assets: {
        Row: {
          bucket_id: string;
          byte_size: number | null;
          character_id: string;
          content_type: string;
          created_at: string;
          created_by_user_id: string | null;
          deletion_started_at: string | null;
          deletion_started_by_user_id: string | null;
          disabled_at: string | null;
          disabled_by_user_id: string | null;
          disabled_reason: string | null;
          display_name: string | null;
          height: number | null;
          id: string;
          ingest_status: string;
          is_global: boolean;
          locked_delivery_path: string | null;
          locked_derivative_completed_at: string | null;
          locked_derivative_error_code: string | null;
          locked_derivative_processing_by_user_id: string | null;
          locked_derivative_processing_started_at: string | null;
          locked_derivative_status: string;
          locked_derivatives_generated_at: string | null;
          locked_price_credits: number | null;
          locked_teaser_path: string | null;
          media_tag_id: string;
          metadata: Json;
          paid_open_price_credits: number | null;
          preview_generated_at: string | null;
          preview_path: string | null;
          processing_attempts: number;
          processing_error_code: string | null;
          processing_started_at: string | null;
          sha256: string | null;
          source_path: string;
          status: string;
          status_before_disabled: string | null;
          updated_at: string;
          updated_by_user_id: string | null;
          width: number | null;
        };
        Insert: {
          bucket_id?: string;
          byte_size?: number | null;
          character_id: string;
          content_type: string;
          created_at?: string;
          created_by_user_id?: string | null;
          deletion_started_at?: string | null;
          deletion_started_by_user_id?: string | null;
          disabled_at?: string | null;
          disabled_by_user_id?: string | null;
          disabled_reason?: string | null;
          display_name?: string | null;
          height?: number | null;
          id?: string;
          ingest_status?: string;
          is_global?: boolean;
          locked_delivery_path?: string | null;
          locked_derivative_completed_at?: string | null;
          locked_derivative_error_code?: string | null;
          locked_derivative_processing_by_user_id?: string | null;
          locked_derivative_processing_started_at?: string | null;
          locked_derivative_status?: string;
          locked_derivatives_generated_at?: string | null;
          locked_price_credits?: number | null;
          locked_teaser_path?: string | null;
          media_tag_id: string;
          metadata?: Json;
          paid_open_price_credits?: number | null;
          preview_generated_at?: string | null;
          preview_path?: string | null;
          processing_attempts?: number;
          processing_error_code?: string | null;
          processing_started_at?: string | null;
          sha256?: string | null;
          source_path: string;
          status?: string;
          status_before_disabled?: string | null;
          updated_at?: string;
          updated_by_user_id?: string | null;
          width?: number | null;
        };
        Update: {
          bucket_id?: string;
          byte_size?: number | null;
          character_id?: string;
          content_type?: string;
          created_at?: string;
          created_by_user_id?: string | null;
          deletion_started_at?: string | null;
          deletion_started_by_user_id?: string | null;
          disabled_at?: string | null;
          disabled_by_user_id?: string | null;
          disabled_reason?: string | null;
          display_name?: string | null;
          height?: number | null;
          id?: string;
          ingest_status?: string;
          is_global?: boolean;
          locked_delivery_path?: string | null;
          locked_derivative_completed_at?: string | null;
          locked_derivative_error_code?: string | null;
          locked_derivative_processing_by_user_id?: string | null;
          locked_derivative_processing_started_at?: string | null;
          locked_derivative_status?: string;
          locked_derivatives_generated_at?: string | null;
          locked_price_credits?: number | null;
          locked_teaser_path?: string | null;
          media_tag_id?: string;
          metadata?: Json;
          paid_open_price_credits?: number | null;
          preview_generated_at?: string | null;
          preview_path?: string | null;
          processing_attempts?: number;
          processing_error_code?: string | null;
          processing_started_at?: string | null;
          sha256?: string | null;
          source_path?: string;
          status?: string;
          status_before_disabled?: string | null;
          updated_at?: string;
          updated_by_user_id?: string | null;
          width?: number | null;
        };
        Relationships: [
          {
            foreignKeyName: "character_media_assets_character_id_fkey";
            columns: ["character_id"];
            isOneToOne: false;
            referencedRelation: "characters";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "character_media_assets_media_tag_id_fkey";
            columns: ["media_tag_id"];
            isOneToOne: false;
            referencedRelation: "media_tags";
            referencedColumns: ["id"];
          },
        ];
      };
      character_media_asset_characters: {
        Row: {
          character_id: string;
          created_at: string;
          created_by_user_id: string | null;
          media_asset_id: string;
        };
        Insert: {
          character_id: string;
          created_at?: string;
          created_by_user_id?: string | null;
          media_asset_id: string;
        };
        Update: {
          character_id?: string;
          created_at?: string;
          created_by_user_id?: string | null;
          media_asset_id?: string;
        };
        Relationships: [];
      };
      character_media_asset_tags: {
        Row: {
          created_at: string;
          created_by_user_id: string | null;
          media_asset_id: string;
          media_tag_id: string;
        };
        Insert: {
          created_at?: string;
          created_by_user_id?: string | null;
          media_asset_id: string;
          media_tag_id: string;
        };
        Update: {
          created_at?: string;
          created_by_user_id?: string | null;
          media_asset_id?: string;
          media_tag_id?: string;
        };
        Relationships: [];
      };
      character_media_deliveries: {
        Row: {
          client_id: string;
          conversation_id: string | null;
          delivered_at: string;
          delivered_by_user_id: string | null;
          id: string;
          media_asset_id: string;
          message_attachment_id: string | null;
          metadata: Json;
          reservation_id: string | null;
        };
        Insert: {
          client_id: string;
          conversation_id?: string | null;
          delivered_at?: string;
          delivered_by_user_id?: string | null;
          id?: string;
          media_asset_id: string;
          message_attachment_id?: string | null;
          metadata?: Json;
          reservation_id?: string | null;
        };
        Update: {
          client_id?: string;
          conversation_id?: string | null;
          delivered_at?: string;
          delivered_by_user_id?: string | null;
          id?: string;
          media_asset_id?: string;
          message_attachment_id?: string | null;
          metadata?: Json;
          reservation_id?: string | null;
        };
        Relationships: [];
      };
      character_media_reservations: {
        Row: {
          client_id: string;
          conversation_id: string;
          created_at: string;
          ended_at: string | null;
          ended_by_user_id: string | null;
          ended_reason: string | null;
          expires_at: string;
          id: string;
          intended_access_mode: string;
          media_asset_id: string;
          metadata: Json;
          operator_id: string;
          previous_asset_status: string;
          reserved_by_user_id: string;
          state: string;
        };
        Insert: {
          client_id: string;
          conversation_id: string;
          created_at?: string;
          ended_at?: string | null;
          ended_by_user_id?: string | null;
          ended_reason?: string | null;
          expires_at: string;
          id?: string;
          intended_access_mode?: string;
          media_asset_id: string;
          metadata?: Json;
          operator_id: string;
          previous_asset_status: string;
          reserved_by_user_id: string;
          state?: string;
        };
        Update: {
          client_id?: string;
          conversation_id?: string;
          created_at?: string;
          ended_at?: string | null;
          ended_by_user_id?: string | null;
          ended_reason?: string | null;
          expires_at?: string;
          id?: string;
          intended_access_mode?: string;
          media_asset_id?: string;
          metadata?: Json;
          operator_id?: string;
          previous_asset_status?: string;
          reserved_by_user_id?: string;
          state?: string;
        };
        Relationships: [
          {
            foreignKeyName: "character_media_reservations_conversation_id_fkey";
            columns: ["conversation_id"];
            isOneToOne: false;
            referencedRelation: "conversations";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "character_media_reservations_media_asset_id_fkey";
            columns: ["media_asset_id"];
            isOneToOne: false;
            referencedRelation: "character_media_assets";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "character_media_reservations_operator_id_fkey";
            columns: ["operator_id"];
            isOneToOne: false;
            referencedRelation: "operators";
            referencedColumns: ["id"];
          },
        ];
      };
      character_operator_assignments: {
        Row: {
          character_id: string;
          created_at: string;
          id: string;
          operator_id: string;
        };
        Insert: {
          character_id: string;
          created_at?: string;
          id?: string;
          operator_id: string;
        };
        Update: {
          character_id?: string;
          created_at?: string;
          id?: string;
          operator_id?: string;
        };
        Relationships: [
          {
            foreignKeyName: "character_operator_assignments_character_id_fkey";
            columns: ["character_id"];
            isOneToOne: false;
            referencedRelation: "characters";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "character_operator_assignments_operator_id_fkey";
            columns: ["operator_id"];
            isOneToOne: false;
            referencedRelation: "operators";
            referencedColumns: ["id"];
          },
        ];
      };
      characters: {
        Row: {
          availability_status: Database["public"]["Enums"]["availability_status"];
          avatar_url: string | null;
          category: string | null;
          created_at: string;
          discovery_city_id: string | null;
          fictional_age: number | null;
          full_description: string | null;
          gallery_images: string[] | null;
          id: string;
          interests: string[] | null;
          is_active: boolean;
          is_visible: boolean;
          name: string;
          personality: string | null;
          short_description: string | null;
          updated_at: string;
        };
        Insert: {
          availability_status?: Database["public"]["Enums"]["availability_status"];
          avatar_url?: string | null;
          category?: string | null;
          created_at?: string;
          discovery_city_id?: string | null;
          fictional_age?: number | null;
          full_description?: string | null;
          gallery_images?: string[] | null;
          id?: string;
          interests?: string[] | null;
          is_active?: boolean;
          is_visible?: boolean;
          name: string;
          personality?: string | null;
          short_description?: string | null;
          updated_at?: string;
        };
        Update: {
          availability_status?: Database["public"]["Enums"]["availability_status"];
          avatar_url?: string | null;
          category?: string | null;
          created_at?: string;
          discovery_city_id?: string | null;
          fictional_age?: number | null;
          full_description?: string | null;
          gallery_images?: string[] | null;
          id?: string;
          interests?: string[] | null;
          is_active?: boolean;
          is_visible?: boolean;
          name?: string;
          personality?: string | null;
          short_description?: string | null;
          updated_at?: string;
        };
        Relationships: [
          {
            foreignKeyName: "characters_discovery_city_id_fkey";
            columns: ["discovery_city_id"];
            isOneToOne: false;
            referencedRelation: "discovery_cities";
            referencedColumns: ["id"];
          },
        ];
      };
      client_character_preferences: {
        Row: {
          character_id: string;
          client_id: string;
          created_at: string;
          favorited_at: string | null;
          is_favorite: boolean;
          last_seen_at: string | null;
          liked_at: string | null;
          shown_count: number;
          updated_at: string;
        };
        Insert: {
          character_id: string;
          client_id: string;
          created_at?: string;
          favorited_at?: string | null;
          is_favorite?: boolean;
          last_seen_at?: string | null;
          liked_at?: string | null;
          shown_count?: number;
          updated_at?: string;
        };
        Update: {
          character_id?: string;
          client_id?: string;
          created_at?: string;
          favorited_at?: string | null;
          is_favorite?: boolean;
          last_seen_at?: string | null;
          liked_at?: string | null;
          shown_count?: number;
          updated_at?: string;
        };
        Relationships: [
          {
            foreignKeyName: "client_character_preferences_character_id_fkey";
            columns: ["character_id"];
            isOneToOne: false;
            referencedRelation: "characters";
            referencedColumns: ["id"];
          },
        ];
      };
      client_consent_acceptances: {
        Row: {
          accepted_at: string;
          client_id: string;
          document_id: string;
        };
        Insert: {
          accepted_at?: string;
          client_id: string;
          document_id: string;
        };
        Update: {
          accepted_at?: string;
          client_id?: string;
          document_id?: string;
        };
        Relationships: [
          {
            foreignKeyName: "client_consent_acceptances_document_id_fkey";
            columns: ["document_id"];
            isOneToOne: false;
            referencedRelation: "client_consent_documents";
            referencedColumns: ["id"];
          },
        ];
      };
      client_consent_documents: {
        Row: {
          activated_at: string;
          approval_reference: string | null;
          approved_at: string | null;
          approved_by: string | null;
          consent_key: string;
          created_at: string;
          document_url: string;
          id: string;
          lifecycle_status: string;
          required: boolean;
          retired_at: string | null;
          title: string;
          version: string;
        };
        Insert: {
          activated_at?: string;
          approval_reference?: string | null;
          approved_at?: string | null;
          approved_by?: string | null;
          consent_key: string;
          created_at?: string;
          document_url: string;
          id?: string;
          lifecycle_status?: string;
          required?: boolean;
          retired_at?: string | null;
          title: string;
          version: string;
        };
        Update: {
          activated_at?: string;
          approval_reference?: string | null;
          approved_at?: string | null;
          approved_by?: string | null;
          consent_key?: string;
          created_at?: string;
          document_url?: string;
          id?: string;
          lifecycle_status?: string;
          required?: boolean;
          retired_at?: string | null;
          title?: string;
          version?: string;
        };
        Relationships: [
          {
            foreignKeyName: "client_consent_documents_approved_by_fkey";
            columns: ["approved_by"];
            isOneToOne: false;
            referencedRelation: "users";
            referencedColumns: ["id"];
          },
        ];
      };
      client_conversation_deletions: {
        Row: {
          client_id: string;
          conversation_id: string;
          deleted_at: string;
        };
        Insert: {
          client_id: string;
          conversation_id: string;
          deleted_at?: string;
        };
        Update: {
          client_id?: string;
          conversation_id?: string;
          deleted_at?: string;
        };
        Relationships: [
          {
            foreignKeyName: "client_conversation_deletions_conversation_id_fkey";
            columns: ["conversation_id"];
            isOneToOne: false;
            referencedRelation: "conversations";
            referencedColumns: ["id"];
          },
        ];
      };
      client_discovery_cycle_items: {
        Row: {
          acted_at: string | null;
          action: string | null;
          character_id: string;
          cycle_id: string;
          is_recycled: boolean;
          shown_at: string;
        };
        Insert: {
          acted_at?: string | null;
          action?: string | null;
          character_id: string;
          cycle_id: string;
          is_recycled?: boolean;
          shown_at?: string;
        };
        Update: {
          acted_at?: string | null;
          action?: string | null;
          character_id?: string;
          cycle_id?: string;
          is_recycled?: boolean;
          shown_at?: string;
        };
        Relationships: [
          {
            foreignKeyName: "client_discovery_cycle_items_character_id_fkey";
            columns: ["character_id"];
            isOneToOne: false;
            referencedRelation: "characters";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "client_discovery_cycle_items_cycle_id_fkey";
            columns: ["cycle_id"];
            isOneToOne: false;
            referencedRelation: "client_discovery_cycles";
            referencedColumns: ["id"];
          },
        ];
      };
      client_discovery_cycles: {
        Row: {
          client_id: string;
          completed_at: string | null;
          cycle_number: number;
          filter_hash: string;
          id: string;
          started_at: string;
        };
        Insert: {
          client_id: string;
          completed_at?: string | null;
          cycle_number: number;
          filter_hash: string;
          id?: string;
          started_at?: string;
        };
        Update: {
          client_id?: string;
          completed_at?: string | null;
          cycle_number?: number;
          filter_hash?: string;
          id?: string;
          started_at?: string;
        };
        Relationships: [];
      };
      client_media_uploads: {
        Row: {
          access_expires_at: string | null;
          bucket_id: string;
          byte_size: number | null;
          cleanup_attempts: number;
          cleanup_claimed_at: string | null;
          cleanup_claim_expires_at: string | null;
          cleanup_claim_token: string | null;
          cleanup_error_code: string | null;
          client_id: string;
          content_type: string;
          conversation_id: string;
          created_at: string;
          deleted_at: string | null;
          finalized_at: string | null;
          finalize_claimed_at: string | null;
          finalize_claim_expires_at: string | null;
          finalize_claim_token: string | null;
          id: string;
          idempotency_key: string | null;
          message_attachment_id: string | null;
          message_id: string | null;
          next_cleanup_at: string | null;
          preview_path: string | null;
          source_path: string;
          status: string;
          updated_at: string;
          upload_expires_at: string;
        };
        Insert: {
          access_expires_at?: string | null;
          bucket_id?: string;
          byte_size?: number | null;
          cleanup_attempts?: number;
          cleanup_claimed_at?: string | null;
          cleanup_claim_expires_at?: string | null;
          cleanup_claim_token?: string | null;
          cleanup_error_code?: string | null;
          client_id: string;
          content_type: string;
          conversation_id: string;
          created_at?: string;
          deleted_at?: string | null;
          finalized_at?: string | null;
          finalize_claimed_at?: string | null;
          finalize_claim_expires_at?: string | null;
          finalize_claim_token?: string | null;
          id?: string;
          idempotency_key?: string | null;
          message_attachment_id?: string | null;
          message_id?: string | null;
          next_cleanup_at?: string | null;
          preview_path?: string | null;
          source_path: string;
          status?: string;
          updated_at?: string;
          upload_expires_at: string;
        };
        Update: {
          access_expires_at?: string | null;
          bucket_id?: string;
          byte_size?: number | null;
          cleanup_attempts?: number;
          cleanup_claimed_at?: string | null;
          cleanup_claim_expires_at?: string | null;
          cleanup_claim_token?: string | null;
          cleanup_error_code?: string | null;
          client_id?: string;
          content_type?: string;
          conversation_id?: string;
          created_at?: string;
          deleted_at?: string | null;
          finalized_at?: string | null;
          finalize_claimed_at?: string | null;
          finalize_claim_expires_at?: string | null;
          finalize_claim_token?: string | null;
          id?: string;
          idempotency_key?: string | null;
          message_attachment_id?: string | null;
          message_id?: string | null;
          next_cleanup_at?: string | null;
          preview_path?: string | null;
          source_path?: string;
          status?: string;
          updated_at?: string;
          upload_expires_at?: string;
        };
        Relationships: [
          {
            foreignKeyName: "client_media_uploads_conversation_id_fkey";
            columns: ["conversation_id"];
            isOneToOne: false;
            referencedRelation: "conversations";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "client_media_uploads_message_attachment_fkey";
            columns: ["message_attachment_id"];
            isOneToOne: true;
            referencedRelation: "message_attachments";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "client_media_uploads_message_id_fkey";
            columns: ["message_id"];
            isOneToOne: true;
            referencedRelation: "messages";
            referencedColumns: ["id"];
          },
        ];
      };
      client_profiles: {
        Row: {
          age: number | null;
          bio: string | null;
          character_preferences: Json;
          city_id: string | null;
          computed_age: number | null;
          content_preferences: Json;
          conversation_preferences: string | null;
          created_at: string;
          date_of_birth: string | null;
          first_name: string | null;
          gender: string | null;
          id: string;
          interests: string[] | null;
          last_name: string | null;
          onboarding_completed_at: string | null;
          onboarding_step: number;
          preferred_distance_km: number | null;
          preferred_max_age: number | null;
          preferred_min_age: number | null;
          profile_image_url: string | null;
          profile_image_urls: string[];
          relationship_status: string | null;
          smoking_status: string | null;
          updated_at: string;
          user_id: string;
        };
        Insert: {
          age?: number | null;
          bio?: string | null;
          character_preferences?: Json;
          city_id?: string | null;
          computed_age?: number | null;
          content_preferences?: Json;
          conversation_preferences?: string | null;
          created_at?: string;
          date_of_birth?: string | null;
          first_name?: string | null;
          gender?: string | null;
          id?: string;
          interests?: string[] | null;
          last_name?: string | null;
          onboarding_completed_at?: string | null;
          onboarding_step?: number;
          preferred_distance_km?: number | null;
          preferred_max_age?: number | null;
          preferred_min_age?: number | null;
          profile_image_url?: string | null;
          profile_image_urls?: string[];
          relationship_status?: string | null;
          smoking_status?: string | null;
          updated_at?: string;
          user_id: string;
        };
        Update: {
          age?: number | null;
          bio?: string | null;
          character_preferences?: Json;
          city_id?: string | null;
          computed_age?: number | null;
          content_preferences?: Json;
          conversation_preferences?: string | null;
          created_at?: string;
          date_of_birth?: string | null;
          first_name?: string | null;
          gender?: string | null;
          id?: string;
          interests?: string[] | null;
          last_name?: string | null;
          onboarding_completed_at?: string | null;
          onboarding_step?: number;
          preferred_distance_km?: number | null;
          preferred_max_age?: number | null;
          preferred_min_age?: number | null;
          profile_image_url?: string | null;
          profile_image_urls?: string[];
          relationship_status?: string | null;
          smoking_status?: string | null;
          updated_at?: string;
          user_id?: string;
        };
        Relationships: [
          {
            foreignKeyName: "client_profiles_city_id_fkey";
            columns: ["city_id"];
            isOneToOne: false;
            referencedRelation: "discovery_cities";
            referencedColumns: ["id"];
          },
        ];
      };
      conversation_handling_cycles: {
        Row: {
          conversation_id: string;
          created_at: string;
          end_reason: string | null;
          ended_at: string | null;
          id: string;
          operator_id: string;
          started_at: string;
          work_item_id: string | null;
        };
        Insert: {
          conversation_id: string;
          created_at?: string;
          end_reason?: string | null;
          ended_at?: string | null;
          id?: string;
          operator_id: string;
          started_at?: string;
          work_item_id?: string | null;
        };
        Update: {
          conversation_id?: string;
          created_at?: string;
          end_reason?: string | null;
          ended_at?: string | null;
          id?: string;
          operator_id?: string;
          started_at?: string;
          work_item_id?: string | null;
        };
        Relationships: [
          {
            foreignKeyName: "conversation_handling_cycles_conversation_id_fkey";
            columns: ["conversation_id"];
            isOneToOne: false;
            referencedRelation: "conversations";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "conversation_handling_cycles_operator_id_fkey";
            columns: ["operator_id"];
            isOneToOne: false;
            referencedRelation: "operators";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "conversation_handling_cycles_work_item_id_fkey";
            columns: ["work_item_id"];
            isOneToOne: false;
            referencedRelation: "conversation_work_items";
            referencedColumns: ["id"];
          },
        ];
      };
      conversation_locks: {
        Row: {
          conversation_id: string;
          expires_at: string;
          last_activity_at: string;
          locked_at: string;
          locked_by_operator_id: string;
          locked_by_user_id: string;
          metadata: Json;
          release_reason: string | null;
          released_at: string | null;
          released_by_user_id: string | null;
        };
        Insert: {
          conversation_id: string;
          expires_at: string;
          last_activity_at?: string;
          locked_at?: string;
          locked_by_operator_id: string;
          locked_by_user_id: string;
          metadata?: Json;
          release_reason?: string | null;
          released_at?: string | null;
          released_by_user_id?: string | null;
        };
        Update: {
          conversation_id?: string;
          expires_at?: string;
          last_activity_at?: string;
          locked_at?: string;
          locked_by_operator_id?: string;
          locked_by_user_id?: string;
          metadata?: Json;
          release_reason?: string | null;
          released_at?: string | null;
          released_by_user_id?: string | null;
        };
        Relationships: [
          {
            foreignKeyName: "conversation_locks_conversation_id_fkey";
            columns: ["conversation_id"];
            isOneToOne: true;
            referencedRelation: "conversations";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "conversation_locks_locked_by_operator_id_fkey";
            columns: ["locked_by_operator_id"];
            isOneToOne: false;
            referencedRelation: "operators";
            referencedColumns: ["id"];
          },
        ];
      };
      conversation_read_states: {
        Row: {
          conversation_id: string;
          last_read_at: string;
          last_read_message_id: string | null;
          user_id: string;
        };
        Insert: {
          conversation_id: string;
          last_read_at?: string;
          last_read_message_id?: string | null;
          user_id: string;
        };
        Update: {
          conversation_id?: string;
          last_read_at?: string;
          last_read_message_id?: string | null;
          user_id?: string;
        };
        Relationships: [
          {
            foreignKeyName: "conversation_read_states_conversation_id_fkey";
            columns: ["conversation_id"];
            isOneToOne: false;
            referencedRelation: "conversations";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "conversation_read_states_last_read_message_id_fkey";
            columns: ["last_read_message_id"];
            isOneToOne: false;
            referencedRelation: "messages";
            referencedColumns: ["id"];
          },
        ];
      };
      conversation_work_items: {
        Row: {
          assigned_at: string | null;
          character_id: string;
          client_id: string;
          conversation_id: string;
          created_at: string;
          id: string;
          last_activity_at: string;
          last_client_message_id: string | null;
          responsible_operator_id: string | null;
          status: string;
          updated_at: string;
        };
        Insert: {
          assigned_at?: string | null;
          character_id: string;
          client_id: string;
          conversation_id: string;
          created_at?: string;
          id?: string;
          last_activity_at?: string;
          last_client_message_id?: string | null;
          responsible_operator_id?: string | null;
          status?: string;
          updated_at?: string;
        };
        Update: {
          assigned_at?: string | null;
          character_id?: string;
          client_id?: string;
          conversation_id?: string;
          created_at?: string;
          id?: string;
          last_activity_at?: string;
          last_client_message_id?: string | null;
          responsible_operator_id?: string | null;
          status?: string;
          updated_at?: string;
        };
        Relationships: [
          {
            foreignKeyName: "conversation_work_items_character_id_fkey";
            columns: ["character_id"];
            isOneToOne: false;
            referencedRelation: "characters";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "conversation_work_items_conversation_id_fkey";
            columns: ["conversation_id"];
            isOneToOne: false;
            referencedRelation: "conversations";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "conversation_work_items_last_client_message_id_fkey";
            columns: ["last_client_message_id"];
            isOneToOne: false;
            referencedRelation: "messages";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "conversation_work_items_responsible_operator_id_fkey";
            columns: ["responsible_operator_id"];
            isOneToOne: false;
            referencedRelation: "operators";
            referencedColumns: ["id"];
          },
        ];
      };
      client_level_progress: {
        Row: {
          client_id: string;
          eligible_message_count: number;
          level: number;
          updated_at: string;
        };
        Insert: {
          client_id: string;
          eligible_message_count?: number;
          level?: number;
          updated_at?: string;
        };
        Update: {
          client_id?: string;
          eligible_message_count?: number;
          level?: number;
          updated_at?: string;
        };
        Relationships: [];
      };
      conversation_presence_states: {
        Row: {
          active_in_conversation: boolean;
          conversation_id: string;
          display_name: string;
          expires_at: string;
          is_typing: boolean;
          last_seen_at: string;
          role: string;
          user_id: string;
        };
        Insert: {
          active_in_conversation?: boolean;
          conversation_id: string;
          display_name: string;
          expires_at?: string;
          is_typing?: boolean;
          last_seen_at?: string;
          role: string;
          user_id: string;
        };
        Update: {
          active_in_conversation?: boolean;
          conversation_id?: string;
          display_name?: string;
          expires_at?: string;
          is_typing?: boolean;
          last_seen_at?: string;
          role?: string;
          user_id?: string;
        };
        Relationships: [
          {
            foreignKeyName: "conversation_presence_states_conversation_id_fkey";
            columns: ["conversation_id"];
            isOneToOne: false;
            referencedRelation: "conversations";
            referencedColumns: ["id"];
          },
        ];
      };
      client_level_transitions: {
        Row: {
          client_id: string;
          created_at: string;
          from_level: number;
          id: string;
          message_id: string;
          notified_at: string | null;
          to_level: number;
        };
        Insert: {
          client_id: string;
          created_at?: string;
          from_level: number;
          id?: string;
          message_id: string;
          notified_at?: string | null;
          to_level: number;
        };
        Update: {
          client_id?: string;
          created_at?: string;
          from_level?: number;
          id?: string;
          message_id?: string;
          notified_at?: string | null;
          to_level?: number;
        };
        Relationships: [];
      };
      conversations: {
        Row: {
          assigned_operator_id: string | null;
          character_id: string;
          client_hidden_at: string | null;
          client_id: string;
          client_unread_count: number;
          created_at: string;
          handling_next_sequence: number;
          handling_state_initialized: boolean;
          handling_state_updated_at: string | null;
          id: string;
          inactivity_expires_at: string | null;
          last_business_message_at: string | null;
          last_handling_message_sequence: number | null;
          last_message_at: string | null;
          last_message_preview: string | null;
          needs_handling: boolean | null;
          operator_unread_count: number;
          pending_since: string | null;
          status: Database["public"]["Enums"]["conversation_status"];
          updated_at: string;
        };
        Insert: {
          assigned_operator_id?: string | null;
          character_id: string;
          client_hidden_at?: string | null;
          client_id: string;
          client_unread_count?: number;
          created_at?: string;
          handling_next_sequence?: number;
          handling_state_initialized?: boolean;
          handling_state_updated_at?: string | null;
          id?: string;
          inactivity_expires_at?: string | null;
          last_business_message_at?: string | null;
          last_handling_message_sequence?: number | null;
          last_message_at?: string | null;
          last_message_preview?: string | null;
          needs_handling?: boolean | null;
          operator_unread_count?: number;
          pending_since?: string | null;
          status?: Database["public"]["Enums"]["conversation_status"];
          updated_at?: string;
        };
        Update: {
          assigned_operator_id?: string | null;
          character_id?: string;
          client_hidden_at?: string | null;
          client_id?: string;
          client_unread_count?: number;
          created_at?: string;
          handling_next_sequence?: number;
          handling_state_initialized?: boolean;
          handling_state_updated_at?: string | null;
          id?: string;
          inactivity_expires_at?: string | null;
          last_business_message_at?: string | null;
          last_handling_message_sequence?: number | null;
          last_message_at?: string | null;
          last_message_preview?: string | null;
          needs_handling?: boolean | null;
          operator_unread_count?: number;
          pending_since?: string | null;
          status?: Database["public"]["Enums"]["conversation_status"];
          updated_at?: string;
        };
        Relationships: [
          {
            foreignKeyName: "conversations_assigned_operator_id_fkey";
            columns: ["assigned_operator_id"];
            isOneToOne: false;
            referencedRelation: "operators";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "conversations_character_id_fkey";
            columns: ["character_id"];
            isOneToOne: false;
            referencedRelation: "characters";
            referencedColumns: ["id"];
          },
        ];
      };
      credit_packages: {
        Row: {
          created_at: string;
          credits: number;
          currency: string;
          id: string;
          is_active: boolean;
          metadata: Json;
          name: string;
          price: number;
          sort_order: number;
          updated_at: string;
        };
        Insert: {
          created_at?: string;
          credits: number;
          currency?: string;
          id?: string;
          is_active?: boolean;
          metadata?: Json;
          name: string;
          price: number;
          sort_order?: number;
          updated_at?: string;
        };
        Update: {
          created_at?: string;
          credits?: number;
          currency?: string;
          id?: string;
          is_active?: boolean;
          metadata?: Json;
          name?: string;
          price?: number;
          sort_order?: number;
          updated_at?: string;
        };
        Relationships: [];
      };
      credit_requests: {
        Row: {
          client_id: string;
          credits_snapshot: number;
          currency_snapshot: string;
          id: string;
          idempotency_key: string;
          package_id: string | null;
          package_name_snapshot: string;
          price_snapshot: number;
          requested_at: string;
          resolution_note: string | null;
          resolved_at: string | null;
          resolved_by: string | null;
          status: string;
          transaction_id: string | null;
        };
        Insert: {
          client_id: string;
          credits_snapshot: number;
          currency_snapshot: string;
          id?: string;
          idempotency_key: string;
          package_id?: string | null;
          package_name_snapshot: string;
          price_snapshot: number;
          requested_at?: string;
          resolution_note?: string | null;
          resolved_at?: string | null;
          resolved_by?: string | null;
          status?: string;
          transaction_id?: string | null;
        };
        Update: {
          client_id?: string;
          credits_snapshot?: number;
          currency_snapshot?: string;
          id?: string;
          idempotency_key?: string;
          package_id?: string | null;
          package_name_snapshot?: string;
          price_snapshot?: number;
          requested_at?: string;
          resolution_note?: string | null;
          resolved_at?: string | null;
          resolved_by?: string | null;
          status?: string;
          transaction_id?: string | null;
        };
        Relationships: [];
      };
      credit_transactions: {
        Row: {
          amount: number;
          balance_after: number;
          created_at: string;
          created_by: string | null;
          id: string;
          message_attachment_id: string | null;
          message_id: string | null;
          metadata: Json;
          package_id: string | null;
          reason: string | null;
          type: string;
          user_id: string;
        };
        Insert: {
          amount: number;
          balance_after: number;
          created_at?: string;
          created_by?: string | null;
          id?: string;
          message_attachment_id?: string | null;
          message_id?: string | null;
          metadata?: Json;
          package_id?: string | null;
          reason?: string | null;
          type: string;
          user_id: string;
        };
        Update: {
          amount?: number;
          balance_after?: number;
          created_at?: string;
          created_by?: string | null;
          id?: string;
          message_attachment_id?: string | null;
          message_id?: string | null;
          metadata?: Json;
          package_id?: string | null;
          reason?: string | null;
          type?: string;
          user_id?: string;
        };
        Relationships: [
          {
            foreignKeyName: "credit_transactions_message_attachment_id_fkey";
            columns: ["message_attachment_id"];
            isOneToOne: false;
            referencedRelation: "message_attachments";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "credit_transactions_message_id_fkey";
            columns: ["message_id"];
            isOneToOne: false;
            referencedRelation: "messages";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "credit_transactions_package_id_fkey";
            columns: ["package_id"];
            isOneToOne: false;
            referencedRelation: "credit_packages";
            referencedColumns: ["id"];
          },
        ];
      };
      credit_wallets: {
        Row: {
          balance: number;
          created_at: string;
          lifetime_earned: number;
          lifetime_spent: number;
          updated_at: string;
          user_id: string;
        };
        Insert: {
          balance?: number;
          created_at?: string;
          lifetime_earned?: number;
          lifetime_spent?: number;
          updated_at?: string;
          user_id: string;
        };
        Update: {
          balance?: number;
          created_at?: string;
          lifetime_earned?: number;
          lifetime_spent?: number;
          updated_at?: string;
          user_id?: string;
        };
        Relationships: [];
      };
      customer_info_entries: {
        Row: {
          client_id: string;
          content: string;
          conversation_id: string | null;
          created_at: string;
          created_by_user_id: string;
          id: string;
          metadata: Json;
          operator_id: string;
          updated_at: string;
        };
        Insert: {
          client_id: string;
          content: string;
          conversation_id?: string | null;
          created_at?: string;
          created_by_user_id: string;
          id?: string;
          metadata?: Json;
          operator_id: string;
          updated_at?: string;
        };
        Update: {
          client_id?: string;
          content?: string;
          conversation_id?: string | null;
          created_at?: string;
          created_by_user_id?: string;
          id?: string;
          metadata?: Json;
          operator_id?: string;
          updated_at?: string;
        };
        Relationships: [
          {
            foreignKeyName: "customer_info_entries_conversation_id_fkey";
            columns: ["conversation_id"];
            isOneToOne: false;
            referencedRelation: "conversations";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "customer_info_entries_operator_id_fkey";
            columns: ["operator_id"];
            isOneToOne: false;
            referencedRelation: "operators";
            referencedColumns: ["id"];
          },
        ];
      };
      discovery_cities: {
        Row: {
          created_at: string;
          display_name_he: string;
          id: string;
          is_active: boolean;
          latitude: number | null;
          longitude: number | null;
          slug: string;
        };
        Insert: {
          created_at?: string;
          display_name_he: string;
          id?: string;
          is_active?: boolean;
          latitude?: number | null;
          longitude?: number | null;
          slug: string;
        };
        Update: {
          created_at?: string;
          display_name_he?: string;
          id?: string;
          is_active?: boolean;
          latitude?: number | null;
          longitude?: number | null;
          slug?: string;
        };
        Relationships: [];
      };
      gift_attachment_purchases: {
        Row: {
          attachment_id: string;
          charged_transaction_id: string | null;
          client_id: string;
          conversation_id: string;
          created_at: string;
          gift_id: string;
          gift_message_id: string | null;
          gift_name_snapshot: string;
          id: string;
          idempotency_key: string;
          opened_at: string | null;
          price_credits_snapshot: number;
          purchased_at: string | null;
          status: string;
        };
        Insert: {
          attachment_id: string;
          charged_transaction_id?: string | null;
          client_id: string;
          conversation_id: string;
          created_at?: string;
          gift_id: string;
          gift_message_id?: string | null;
          gift_name_snapshot: string;
          id?: string;
          idempotency_key: string;
          opened_at?: string | null;
          price_credits_snapshot: number;
          purchased_at?: string | null;
          status?: string;
        };
        Update: {
          attachment_id?: string;
          charged_transaction_id?: string | null;
          client_id?: string;
          conversation_id?: string;
          created_at?: string;
          gift_id?: string;
          gift_message_id?: string | null;
          gift_name_snapshot?: string;
          id?: string;
          idempotency_key?: string;
          opened_at?: string | null;
          price_credits_snapshot?: number;
          purchased_at?: string | null;
          status?: string;
        };
        Relationships: [
          {
            foreignKeyName: "gift_attachment_purchases_attachment_id_fkey";
            columns: ["attachment_id"];
            isOneToOne: false;
            referencedRelation: "message_attachments";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "gift_attachment_purchases_charged_transaction_id_fkey";
            columns: ["charged_transaction_id"];
            isOneToOne: true;
            referencedRelation: "credit_transactions";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "gift_attachment_purchases_conversation_id_fkey";
            columns: ["conversation_id"];
            isOneToOne: false;
            referencedRelation: "conversations";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "gift_attachment_purchases_gift_id_fkey";
            columns: ["gift_id"];
            isOneToOne: false;
            referencedRelation: "stickers";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "gift_attachment_purchases_gift_message_id_fkey";
            columns: ["gift_message_id"];
            isOneToOne: true;
            referencedRelation: "messages";
            referencedColumns: ["id"];
          },
        ];
      };
      internal_notes: {
        Row: {
          conversation_id: string;
          created_at: string;
          id: string;
          note: string;
          operator_id: string | null;
        };
        Insert: {
          conversation_id: string;
          created_at?: string;
          id?: string;
          note: string;
          operator_id?: string | null;
        };
        Update: {
          conversation_id?: string;
          created_at?: string;
          id?: string;
          note?: string;
          operator_id?: string | null;
        };
        Relationships: [
          {
            foreignKeyName: "internal_notes_conversation_id_fkey";
            columns: ["conversation_id"];
            isOneToOne: false;
            referencedRelation: "conversations";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "internal_notes_operator_id_fkey";
            columns: ["operator_id"];
            isOneToOne: false;
            referencedRelation: "operators";
            referencedColumns: ["id"];
          },
        ];
      };
      invites: {
        Row: {
          accepted_at: string | null;
          character_ids: string[];
          created_at: string;
          email: string;
          expires_at: string;
          full_name: string;
          id: string;
          invited_by: string;
          status: string;
          token_hash: string;
          updated_at: string;
        };
        Insert: {
          accepted_at?: string | null;
          character_ids?: string[];
          created_at?: string;
          email: string;
          expires_at?: string;
          full_name: string;
          id?: string;
          invited_by: string;
          status?: string;
          token_hash: string;
          updated_at?: string;
        };
        Update: {
          accepted_at?: string | null;
          character_ids?: string[];
          created_at?: string;
          email?: string;
          expires_at?: string;
          full_name?: string;
          id?: string;
          invited_by?: string;
          status?: string;
          token_hash?: string;
          updated_at?: string;
        };
        Relationships: [];
      };
      media_tags: {
        Row: {
          character_id: string | null;
          created_at: string;
          created_by_user_id: string | null;
          id: string;
          is_default: boolean;
          name: string;
          sort_order: number;
          updated_at: string;
          updated_by_user_id: string | null;
        };
        Insert: {
          character_id?: string | null;
          created_at?: string;
          created_by_user_id?: string | null;
          id?: string;
          is_default?: boolean;
          name: string;
          sort_order?: number;
          updated_at?: string;
          updated_by_user_id?: string | null;
        };
        Update: {
          character_id?: string | null;
          created_at?: string;
          created_by_user_id?: string | null;
          id?: string;
          is_default?: boolean;
          name?: string;
          sort_order?: number;
          updated_at?: string;
          updated_by_user_id?: string | null;
        };
        Relationships: [
          {
            foreignKeyName: "media_tags_character_id_fkey";
            columns: ["character_id"];
            isOneToOne: false;
            referencedRelation: "characters";
            referencedColumns: ["id"];
          },
        ];
      };
      message_attachment_unlocks: {
        Row: {
          attachment_id: string;
          charged_transaction_id: string;
          client_id: string;
          created_at: string;
          id: string;
          metadata: Json;
          refund_transaction_id: string | null;
          refunded_at: string | null;
          revoked_at: string | null;
          revoked_reason: string | null;
          unlocked_at: string;
        };
        Insert: {
          attachment_id: string;
          charged_transaction_id: string;
          client_id: string;
          created_at?: string;
          id?: string;
          metadata?: Json;
          refund_transaction_id?: string | null;
          refunded_at?: string | null;
          revoked_at?: string | null;
          revoked_reason?: string | null;
          unlocked_at?: string;
        };
        Update: {
          attachment_id?: string;
          charged_transaction_id?: string;
          client_id?: string;
          created_at?: string;
          id?: string;
          metadata?: Json;
          refund_transaction_id?: string | null;
          refunded_at?: string | null;
          revoked_at?: string | null;
          revoked_reason?: string | null;
          unlocked_at?: string;
        };
        Relationships: [
          {
            foreignKeyName: "message_attachment_unlocks_attachment_id_fkey";
            columns: ["attachment_id"];
            isOneToOne: false;
            referencedRelation: "message_attachments";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "message_attachment_unlocks_charged_transaction_id_fkey";
            columns: ["charged_transaction_id"];
            isOneToOne: true;
            referencedRelation: "credit_transactions";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "message_attachment_unlocks_refund_transaction_id_fkey";
            columns: ["refund_transaction_id"];
            isOneToOne: true;
            referencedRelation: "credit_transactions";
            referencedColumns: ["id"];
          },
        ];
      };
      message_attachments: {
        Row: {
          access_mode: string;
          access_expires_at: string | null;
          caption: string | null;
          client_upload_id: string | null;
          created_at: string;
          id: string;
          kind: string;
          media_asset_id: string | null;
          message_id: string;
          metadata: Json;
          position: number;
          price_credits_snapshot: number | null;
          required_gift_id: string | null;
          required_gift_name_snapshot: string | null;
          required_gift_price_credits_snapshot: number | null;
          reservation_id: string | null;
          view_mode: string;
          view_once_completed_at: string | null;
          view_once_opened_at: string | null;
          view_policy_version: string;
        };
        Insert: {
          access_mode?: string;
          access_expires_at?: string | null;
          caption?: string | null;
          client_upload_id?: string | null;
          created_at?: string;
          id?: string;
          kind: string;
          media_asset_id?: string | null;
          message_id: string;
          metadata?: Json;
          position?: number;
          price_credits_snapshot?: number | null;
          required_gift_id?: string | null;
          required_gift_name_snapshot?: string | null;
          required_gift_price_credits_snapshot?: number | null;
          reservation_id?: string | null;
          view_mode?: string;
          view_once_completed_at?: string | null;
          view_once_opened_at?: string | null;
          view_policy_version?: string;
        };
        Update: {
          access_mode?: string;
          access_expires_at?: string | null;
          caption?: string | null;
          client_upload_id?: string | null;
          created_at?: string;
          id?: string;
          kind?: string;
          media_asset_id?: string | null;
          message_id?: string;
          metadata?: Json;
          position?: number;
          price_credits_snapshot?: number | null;
          required_gift_id?: string | null;
          required_gift_name_snapshot?: string | null;
          required_gift_price_credits_snapshot?: number | null;
          reservation_id?: string | null;
          view_mode?: string;
          view_once_completed_at?: string | null;
          view_once_opened_at?: string | null;
          view_policy_version?: string;
        };
        Relationships: [
          {
            foreignKeyName: "message_attachments_client_upload_id_fkey";
            columns: ["client_upload_id"];
            isOneToOne: true;
            referencedRelation: "client_media_uploads";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "message_attachments_media_asset_id_fkey";
            columns: ["media_asset_id"];
            isOneToOne: false;
            referencedRelation: "character_media_assets";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "message_attachments_message_id_fkey";
            columns: ["message_id"];
            isOneToOne: false;
            referencedRelation: "messages";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "message_attachments_reservation_id_fkey";
            columns: ["reservation_id"];
            isOneToOne: true;
            referencedRelation: "character_media_reservations";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "message_attachments_required_gift_id_fkey";
            columns: ["required_gift_id"];
            isOneToOne: false;
            referencedRelation: "stickers";
            referencedColumns: ["id"];
          },
        ];
      };
      message_stickers: {
        Row: {
          charged_transaction_id: string | null;
          collection_name_snapshot: string;
          created_at: string;
          id: string;
          message_id: string;
          payer_client_id: string | null;
          payout_operator_id: string | null;
          payout_transaction_id: string | null;
          price_credits_snapshot: number;
          sticker_id: string;
          sticker_name_snapshot: string;
        };
        Insert: {
          charged_transaction_id?: string | null;
          collection_name_snapshot: string;
          created_at?: string;
          id?: string;
          message_id: string;
          payer_client_id?: string | null;
          payout_operator_id?: string | null;
          payout_transaction_id?: string | null;
          price_credits_snapshot?: number;
          sticker_id: string;
          sticker_name_snapshot: string;
        };
        Update: {
          charged_transaction_id?: string | null;
          collection_name_snapshot?: string;
          created_at?: string;
          id?: string;
          message_id?: string;
          payer_client_id?: string | null;
          payout_operator_id?: string | null;
          payout_transaction_id?: string | null;
          price_credits_snapshot?: number;
          sticker_id?: string;
          sticker_name_snapshot?: string;
        };
        Relationships: [
          {
            foreignKeyName: "message_stickers_charged_transaction_id_fkey";
            columns: ["charged_transaction_id"];
            isOneToOne: true;
            referencedRelation: "credit_transactions";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "message_stickers_message_id_fkey";
            columns: ["message_id"];
            isOneToOne: true;
            referencedRelation: "messages";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "message_stickers_payout_operator_id_fkey";
            columns: ["payout_operator_id"];
            isOneToOne: false;
            referencedRelation: "operators";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "message_stickers_payout_transaction_id_fkey";
            columns: ["payout_transaction_id"];
            isOneToOne: true;
            referencedRelation: "credit_transactions";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "message_stickers_sticker_id_fkey";
            columns: ["sticker_id"];
            isOneToOne: false;
            referencedRelation: "stickers";
            referencedColumns: ["id"];
          },
        ];
      };
      messages: {
        Row: {
          content: string;
          conversation_id: string;
          created_at: string;
          handling_classification_reason: string | null;
          handling_classified_at: string | null;
          handling_cycle_id: string | null;
          handling_effect: string | null;
          handling_metadata_version: number | null;
          handling_sequence: number | null;
          id: string;
          is_read: boolean;
          operator_id: string | null;
          sender_id: string | null;
          sender_type: Database["public"]["Enums"]["sender_type"];
        };
        Insert: {
          content: string;
          conversation_id: string;
          created_at?: string;
          handling_classification_reason?: string | null;
          handling_classified_at?: string | null;
          handling_cycle_id?: string | null;
          handling_effect?: string | null;
          handling_metadata_version?: number | null;
          handling_sequence?: number | null;
          id?: string;
          is_read?: boolean;
          operator_id?: string | null;
          sender_id?: string | null;
          sender_type: Database["public"]["Enums"]["sender_type"];
        };
        Update: {
          content?: string;
          conversation_id?: string;
          created_at?: string;
          handling_classification_reason?: string | null;
          handling_classified_at?: string | null;
          handling_cycle_id?: string | null;
          handling_effect?: string | null;
          handling_metadata_version?: number | null;
          handling_sequence?: number | null;
          id?: string;
          is_read?: boolean;
          operator_id?: string | null;
          sender_id?: string | null;
          sender_type?: Database["public"]["Enums"]["sender_type"];
        };
        Relationships: [
          {
            foreignKeyName: "messages_conversation_id_fkey";
            columns: ["conversation_id"];
            isOneToOne: false;
            referencedRelation: "conversations";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "messages_handling_cycle_id_fkey";
            columns: ["handling_cycle_id"];
            isOneToOne: false;
            referencedRelation: "conversation_handling_cycles";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "messages_operator_id_fkey";
            columns: ["operator_id"];
            isOneToOne: false;
            referencedRelation: "operators";
            referencedColumns: ["id"];
          },
        ];
      };
      notification_settings: {
        Row: {
          assignment_enabled: boolean;
          created_at: string;
          credits_enabled: boolean;
          email_enabled: boolean;
          in_app_enabled: boolean;
          lock_enabled: boolean;
          new_message_enabled: boolean;
          new_report_enabled: boolean;
          system_enabled: boolean;
          updated_at: string;
          user_id: string;
        };
        Insert: {
          assignment_enabled?: boolean;
          created_at?: string;
          credits_enabled?: boolean;
          email_enabled?: boolean;
          in_app_enabled?: boolean;
          lock_enabled?: boolean;
          new_message_enabled?: boolean;
          new_report_enabled?: boolean;
          system_enabled?: boolean;
          updated_at?: string;
          user_id: string;
        };
        Update: {
          assignment_enabled?: boolean;
          created_at?: string;
          credits_enabled?: boolean;
          email_enabled?: boolean;
          in_app_enabled?: boolean;
          lock_enabled?: boolean;
          new_message_enabled?: boolean;
          new_report_enabled?: boolean;
          system_enabled?: boolean;
          updated_at?: string;
          user_id?: string;
        };
        Relationships: [];
      };
      notifications: {
        Row: {
          body: string | null;
          conversation_id: string | null;
          created_at: string;
          id: string;
          is_read: boolean;
          link: string | null;
          metadata: Json;
          title: string;
          type: string;
          user_id: string;
        };
        Insert: {
          body?: string | null;
          conversation_id?: string | null;
          created_at?: string;
          id?: string;
          is_read?: boolean;
          link?: string | null;
          metadata?: Json;
          title: string;
          type: string;
          user_id: string;
        };
        Update: {
          body?: string | null;
          conversation_id?: string | null;
          created_at?: string;
          id?: string;
          is_read?: boolean;
          link?: string | null;
          metadata?: Json;
          title?: string;
          type?: string;
          user_id?: string;
        };
        Relationships: [
          {
            foreignKeyName: "notifications_conversation_id_fkey";
            columns: ["conversation_id"];
            isOneToOne: false;
            referencedRelation: "conversations";
            referencedColumns: ["id"];
          },
        ];
      };
      operator_client_blocks: {
        Row: {
          client_id: string;
          created_at: string;
          created_by_operator_id: string;
          operator_id: string;
          reason: string | null;
        };
        Insert: {
          client_id: string;
          created_at?: string;
          created_by_operator_id: string;
          operator_id: string;
          reason?: string | null;
        };
        Update: {
          client_id?: string;
          created_at?: string;
          created_by_operator_id?: string;
          operator_id?: string;
          reason?: string | null;
        };
        Relationships: [
          {
            foreignKeyName: "operator_client_blocks_created_by_operator_id_fkey";
            columns: ["created_by_operator_id"];
            isOneToOne: false;
            referencedRelation: "operators";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "operator_client_blocks_operator_id_fkey";
            columns: ["operator_id"];
            isOneToOne: false;
            referencedRelation: "operators";
            referencedColumns: ["id"];
          },
        ];
      };
      operator_client_reports: {
        Row: {
          client_id: string;
          conversation_id: string | null;
          created_at: string;
          id: string;
          notes: string | null;
          operator_id: string;
          reason: string;
          source: string;
        };
        Insert: {
          client_id: string;
          conversation_id?: string | null;
          created_at?: string;
          id?: string;
          notes?: string | null;
          operator_id: string;
          reason: string;
          source?: string;
        };
        Update: {
          client_id?: string;
          conversation_id?: string | null;
          created_at?: string;
          id?: string;
          notes?: string | null;
          operator_id?: string;
          reason?: string;
          source?: string;
        };
        Relationships: [
          {
            foreignKeyName: "operator_client_reports_conversation_id_fkey";
            columns: ["conversation_id"];
            isOneToOne: false;
            referencedRelation: "conversations";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "operator_client_reports_operator_id_fkey";
            columns: ["operator_id"];
            isOneToOne: false;
            referencedRelation: "operators";
            referencedColumns: ["id"];
          },
        ];
      };
      operator_monthly_scores: {
        Row: {
          message_count: number;
          operator_id: string;
          period_month: string;
          points: number;
          updated_at: string;
        };
        Insert: {
          message_count?: number;
          operator_id: string;
          period_month: string;
          points?: number;
          updated_at?: string;
        };
        Update: {
          message_count?: number;
          operator_id?: string;
          period_month?: string;
          points?: number;
          updated_at?: string;
        };
        Relationships: [
          {
            foreignKeyName: "operator_monthly_scores_operator_id_fkey";
            columns: ["operator_id"];
            isOneToOne: false;
            referencedRelation: "operators";
            referencedColumns: ["id"];
          },
        ];
      };
      operator_point_transactions: {
        Row: {
          amount: number;
          balance_after: number;
          created_at: string;
          event_type: string;
          gift_reward_event_id: string | null;
          id: string;
          metadata: Json;
          operator_id: string;
          reason: string;
          source_score_event_id: string | null;
        };
        Insert: {
          amount: number;
          balance_after: number;
          created_at?: string;
          event_type: string;
          gift_reward_event_id?: string | null;
          id?: string;
          metadata?: Json;
          operator_id: string;
          reason: string;
          source_score_event_id?: string | null;
        };
        Update: {
          amount?: number;
          balance_after?: number;
          created_at?: string;
          event_type?: string;
          gift_reward_event_id?: string | null;
          id?: string;
          metadata?: Json;
          operator_id?: string;
          reason?: string;
          source_score_event_id?: string | null;
        };
        Relationships: [
          {
            foreignKeyName: "operator_point_transactions_operator_id_fkey";
            columns: ["operator_id"];
            isOneToOne: false;
            referencedRelation: "operators";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "operator_point_transactions_source_score_event_id_fkey";
            columns: ["source_score_event_id"];
            isOneToOne: true;
            referencedRelation: "operator_score_events";
            referencedColumns: ["id"];
          },
        ];
      };
      operator_point_wallets: {
        Row: {
          balance: number;
          created_at: string;
          lifetime_adjusted: number;
          lifetime_earned: number;
          operator_id: string;
          updated_at: string;
        };
        Insert: {
          balance?: number;
          created_at?: string;
          lifetime_adjusted?: number;
          lifetime_earned?: number;
          operator_id: string;
          updated_at?: string;
        };
        Update: {
          balance?: number;
          created_at?: string;
          lifetime_adjusted?: number;
          lifetime_earned?: number;
          operator_id?: string;
          updated_at?: string;
        };
        Relationships: [
          {
            foreignKeyName: "operator_point_wallets_operator_id_fkey";
            columns: ["operator_id"];
            isOneToOne: true;
            referencedRelation: "operators";
            referencedColumns: ["id"];
          },
        ];
      };
      operator_outreach_attempts: {
        Row: {
          character_id: string;
          client_id: string;
          conversation_id: string | null;
          created_at: string;
          id: string;
          idempotency_key: string;
          message_content: string;
          message_id: string | null;
          operator_id: string;
          result: Json;
          status: string;
        };
        Insert: {
          character_id: string;
          client_id: string;
          conversation_id?: string | null;
          created_at?: string;
          id?: string;
          idempotency_key: string;
          message_content: string;
          message_id?: string | null;
          operator_id: string;
          result?: Json;
          status?: string;
        };
        Update: {
          character_id?: string;
          client_id?: string;
          conversation_id?: string | null;
          created_at?: string;
          id?: string;
          idempotency_key?: string;
          message_content?: string;
          message_id?: string | null;
          operator_id?: string;
          result?: Json;
          status?: string;
        };
        Relationships: [
          {
            foreignKeyName: "operator_outreach_attempts_character_id_fkey";
            columns: ["character_id"];
            isOneToOne: false;
            referencedRelation: "characters";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "operator_outreach_attempts_conversation_id_fkey";
            columns: ["conversation_id"];
            isOneToOne: false;
            referencedRelation: "conversations";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "operator_outreach_attempts_message_id_fkey";
            columns: ["message_id"];
            isOneToOne: false;
            referencedRelation: "messages";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "operator_outreach_attempts_operator_id_fkey";
            columns: ["operator_id"];
            isOneToOne: false;
            referencedRelation: "operators";
            referencedColumns: ["id"];
          },
        ];
      };
      operator_score_events: {
        Row: {
          conversation_id: string;
          created_at: string;
          id: string;
          limit_applied: number | null;
          message_id: string | null;
          metadata: Json;
          operator_id: string;
          period_month: string;
          points: number;
          reason: string;
          streak_position: number | null;
          user_id: string;
        };
        Insert: {
          conversation_id: string;
          created_at?: string;
          id?: string;
          limit_applied?: number | null;
          message_id?: string | null;
          metadata?: Json;
          operator_id: string;
          period_month: string;
          points?: number;
          reason?: string;
          streak_position?: number | null;
          user_id: string;
        };
        Update: {
          conversation_id?: string;
          created_at?: string;
          id?: string;
          limit_applied?: number | null;
          message_id?: string | null;
          metadata?: Json;
          operator_id?: string;
          period_month?: string;
          points?: number;
          reason?: string;
          streak_position?: number | null;
          user_id?: string;
        };
        Relationships: [
          {
            foreignKeyName: "operator_score_events_conversation_id_fkey";
            columns: ["conversation_id"];
            isOneToOne: false;
            referencedRelation: "conversations";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "operator_score_events_message_id_fkey";
            columns: ["message_id"];
            isOneToOne: false;
            referencedRelation: "messages";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "operator_score_events_operator_id_fkey";
            columns: ["operator_id"];
            isOneToOne: false;
            referencedRelation: "operators";
            referencedColumns: ["id"];
          },
        ];
      };
      operators: {
        Row: {
          availability_status: Database["public"]["Enums"]["availability_status"];
          created_at: string;
          deleted_at: string | null;
          full_name: string;
          id: string;
          is_active: boolean;
          last_seen_at: string | null;
          presence_status: string;
          updated_at: string;
          user_id: string;
        };
        Insert: {
          availability_status?: Database["public"]["Enums"]["availability_status"];
          created_at?: string;
          deleted_at?: string | null;
          full_name: string;
          id?: string;
          is_active?: boolean;
          last_seen_at?: string | null;
          presence_status?: string;
          updated_at?: string;
          user_id: string;
        };
        Update: {
          availability_status?: Database["public"]["Enums"]["availability_status"];
          created_at?: string;
          deleted_at?: string | null;
          full_name?: string;
          id?: string;
          is_active?: boolean;
          last_seen_at?: string | null;
          presence_status?: string;
          updated_at?: string;
          user_id?: string;
        };
        Relationships: [];
      };
      profiles: {
        Row: {
          avatar_url: string | null;
          created_at: string;
          deleted_at: string | null;
          display_name: string | null;
          email: string | null;
          id: string;
          pii_archive_reason: string | null;
          pii_archived_at: string | null;
          pii_archived_by: string | null;
          status: string;
          updated_at: string;
          user_id: string;
        };
        Insert: {
          avatar_url?: string | null;
          created_at?: string;
          deleted_at?: string | null;
          display_name?: string | null;
          email?: string | null;
          id?: string;
          pii_archive_reason?: string | null;
          pii_archived_at?: string | null;
          pii_archived_by?: string | null;
          status?: string;
          updated_at?: string;
          user_id: string;
        };
        Update: {
          avatar_url?: string | null;
          created_at?: string;
          deleted_at?: string | null;
          display_name?: string | null;
          email?: string | null;
          id?: string;
          pii_archive_reason?: string | null;
          pii_archived_at?: string | null;
          pii_archived_by?: string | null;
          status?: string;
          updated_at?: string;
          user_id?: string;
        };
        Relationships: [];
      };
      reports: {
        Row: {
          conversation_id: string | null;
          created_at: string;
          details: string | null;
          id: string;
          reason: string;
          reporter_id: string;
          status: Database["public"]["Enums"]["report_status"];
          updated_at: string;
        };
        Insert: {
          conversation_id?: string | null;
          created_at?: string;
          details?: string | null;
          id?: string;
          reason: string;
          reporter_id: string;
          status?: Database["public"]["Enums"]["report_status"];
          updated_at?: string;
        };
        Update: {
          conversation_id?: string | null;
          created_at?: string;
          details?: string | null;
          id?: string;
          reason?: string;
          reporter_id?: string;
          status?: Database["public"]["Enums"]["report_status"];
          updated_at?: string;
        };
        Relationships: [
          {
            foreignKeyName: "reports_conversation_id_fkey";
            columns: ["conversation_id"];
            isOneToOne: false;
            referencedRelation: "conversations";
            referencedColumns: ["id"];
          },
        ];
      };
      sticker_collections: {
        Row: {
          character_id: string | null;
          created_at: string;
          created_by_user_id: string | null;
          id: string;
          is_active: boolean;
          metadata: Json;
          name: string;
          slug: string;
          sort_order: number;
          updated_at: string;
          updated_by_user_id: string | null;
        };
        Insert: {
          character_id?: string | null;
          created_at?: string;
          created_by_user_id?: string | null;
          id?: string;
          is_active?: boolean;
          metadata?: Json;
          name: string;
          slug: string;
          sort_order?: number;
          updated_at?: string;
          updated_by_user_id?: string | null;
        };
        Update: {
          character_id?: string | null;
          created_at?: string;
          created_by_user_id?: string | null;
          id?: string;
          is_active?: boolean;
          metadata?: Json;
          name?: string;
          slug?: string;
          sort_order?: number;
          updated_at?: string;
          updated_by_user_id?: string | null;
        };
        Relationships: [
          {
            foreignKeyName: "sticker_collections_character_id_fkey";
            columns: ["character_id"];
            isOneToOne: false;
            referencedRelation: "characters";
            referencedColumns: ["id"];
          },
        ];
      };
      stickers: {
        Row: {
          bucket_id: string;
          byte_size: number | null;
          collection_id: string;
          content_type: string;
          created_at: string;
          created_by_user_id: string | null;
          deletion_started_at: string | null;
          failed_at: string | null;
          failure_code: string | null;
          height: number | null;
          id: string;
          ingest_status: string;
          is_active: boolean;
          is_gift: boolean;
          metadata: Json;
          name: string;
          object_path: string;
          price_credits: number;
          processed_at: string | null;
          processing_started_at: string | null;
          slug: string;
          sort_order: number;
          source_content_type: string | null;
          source_path: string | null;
          updated_at: string;
          updated_by_user_id: string | null;
          width: number | null;
        };
        Insert: {
          bucket_id?: string;
          byte_size?: number | null;
          collection_id: string;
          content_type?: string;
          created_at?: string;
          created_by_user_id?: string | null;
          deletion_started_at?: string | null;
          failed_at?: string | null;
          failure_code?: string | null;
          height?: number | null;
          id?: string;
          ingest_status?: string;
          is_active?: boolean;
          is_gift?: boolean;
          metadata?: Json;
          name: string;
          object_path: string;
          price_credits?: number;
          processed_at?: string | null;
          processing_started_at?: string | null;
          slug: string;
          sort_order?: number;
          source_content_type?: string | null;
          source_path?: string | null;
          updated_at?: string;
          updated_by_user_id?: string | null;
          width?: number | null;
        };
        Update: {
          bucket_id?: string;
          byte_size?: number | null;
          collection_id?: string;
          content_type?: string;
          created_at?: string;
          created_by_user_id?: string | null;
          deletion_started_at?: string | null;
          failed_at?: string | null;
          failure_code?: string | null;
          height?: number | null;
          id?: string;
          ingest_status?: string;
          is_active?: boolean;
          is_gift?: boolean;
          metadata?: Json;
          name?: string;
          object_path?: string;
          price_credits?: number;
          processed_at?: string | null;
          processing_started_at?: string | null;
          slug?: string;
          sort_order?: number;
          source_content_type?: string | null;
          source_path?: string | null;
          updated_at?: string;
          updated_by_user_id?: string | null;
          width?: number | null;
        };
        Relationships: [
          {
            foreignKeyName: "stickers_collection_id_fkey";
            columns: ["collection_id"];
            isOneToOne: false;
            referencedRelation: "sticker_collections";
            referencedColumns: ["id"];
          },
        ];
      };
      support_incident_actions: {
        Row: {
          action: string;
          actor_admin_id: string;
          created_at: string;
          id: string;
          incident_id: string;
        };
        Insert: {
          action: string;
          actor_admin_id: string;
          created_at?: string;
          id?: string;
          incident_id: string;
        };
        Update: {
          action?: string;
          actor_admin_id?: string;
          created_at?: string;
          id?: string;
          incident_id?: string;
        };
        Relationships: [];
      };
      support_incident_tickets: {
        Row: { incident_id: string; linked_at: string; linked_by: string; ticket_id: string };
        Insert: { incident_id: string; linked_at?: string; linked_by: string; ticket_id: string };
        Update: {
          incident_id?: string;
          linked_at?: string;
          linked_by?: string;
          ticket_id?: string;
        };
        Relationships: [];
      };
      support_incidents: {
        Row: {
          acknowledged_at: string | null;
          escalation_failure_code: string | null;
          escalation_status: string;
          details: string;
          id: string;
          idempotency_key: string;
          incident_type: string;
          opened_at: string;
          opened_by: string;
          owner_admin_id: string | null;
          resolved_at: string | null;
          severity: string;
          status: string;
          title: string;
          updated_at: string;
          version: number;
        };
        Insert: {
          acknowledged_at?: string | null;
          escalation_failure_code?: string | null;
          escalation_status: string;
          details: string;
          id?: string;
          idempotency_key: string;
          incident_type: string;
          opened_at?: string;
          opened_by: string;
          owner_admin_id?: string | null;
          resolved_at?: string | null;
          severity: string;
          status?: string;
          title: string;
          updated_at?: string;
          version?: number;
        };
        Update: {
          acknowledged_at?: string | null;
          escalation_failure_code?: string | null;
          escalation_status?: string;
          details?: string;
          id?: string;
          idempotency_key?: string;
          incident_type?: string;
          opened_at?: string;
          opened_by?: string;
          owner_admin_id?: string | null;
          resolved_at?: string | null;
          severity?: string;
          status?: string;
          title?: string;
          updated_at?: string;
          version?: number;
        };
        Relationships: [];
      };
      support_ticket_messages: {
        Row: {
          author_kind: string;
          author_user_id: string;
          body: string;
          created_at: string;
          id: string;
          idempotency_key: string;
          ticket_id: string;
          visibility: string;
        };
        Insert: {
          author_kind: string;
          author_user_id: string;
          body: string;
          created_at?: string;
          id?: string;
          idempotency_key: string;
          ticket_id: string;
          visibility: string;
        };
        Update: {
          author_kind?: string;
          author_user_id?: string;
          body?: string;
          created_at?: string;
          id?: string;
          idempotency_key?: string;
          ticket_id?: string;
          visibility?: string;
        };
        Relationships: [];
      };
      support_tickets: {
        Row: {
          assignee_admin_id: string | null;
          category: string;
          client_id: string;
          closed_at: string | null;
          created_at: string;
          description: string;
          first_human_response_at: string | null;
          first_response_schedule_version: number | null;
          first_response_target_at: string | null;
          first_response_timezone: string | null;
          first_response_within_target: boolean | null;
          id: string;
          idempotency_key: string;
          status: string;
          subject: string;
          updated_at: string;
          version: number;
        };
        Insert: {
          assignee_admin_id?: string | null;
          category: string;
          client_id: string;
          closed_at?: string | null;
          created_at?: string;
          description: string;
          first_human_response_at?: string | null;
          first_response_schedule_version?: number | null;
          first_response_target_at?: string | null;
          first_response_timezone?: string | null;
          first_response_within_target?: boolean | null;
          id?: string;
          idempotency_key: string;
          status?: string;
          subject: string;
          updated_at?: string;
          version?: number;
        };
        Update: {
          assignee_admin_id?: string | null;
          category?: string;
          client_id?: string;
          closed_at?: string | null;
          created_at?: string;
          description?: string;
          first_human_response_at?: string | null;
          first_response_schedule_version?: number | null;
          first_response_target_at?: string | null;
          first_response_timezone?: string | null;
          first_response_within_target?: boolean | null;
          id?: string;
          idempotency_key?: string;
          status?: string;
          subject?: string;
          updated_at?: string;
          version?: number;
        };
        Relationships: [];
      };
      system_settings: {
        Row: {
          id: string;
          key: string;
          updated_at: string;
          value: Json | null;
        };
        Insert: {
          id?: string;
          key: string;
          updated_at?: string;
          value?: Json | null;
        };
        Update: {
          id?: string;
          key?: string;
          updated_at?: string;
          value?: Json | null;
        };
        Relationships: [];
      };
      user_active_conversations: {
        Row: {
          conversation_id: string;
          expires_at: string;
          last_seen_at: string;
          role: string;
          user_id: string;
        };
        Insert: {
          conversation_id: string;
          expires_at?: string;
          last_seen_at?: string;
          role: string;
          user_id: string;
        };
        Update: {
          conversation_id?: string;
          expires_at?: string;
          last_seen_at?: string;
          role?: string;
          user_id?: string;
        };
        Relationships: [
          {
            foreignKeyName: "user_active_conversations_conversation_id_fkey";
            columns: ["conversation_id"];
            isOneToOne: false;
            referencedRelation: "conversations";
            referencedColumns: ["id"];
          },
        ];
      };
      user_conversation_access_versions: {
        Row: {
          updated_at: string;
          user_id: string;
          version: number;
        };
        Insert: {
          updated_at?: string;
          user_id: string;
          version?: number;
        };
        Update: {
          updated_at?: string;
          user_id?: string;
          version?: number;
        };
        Relationships: [];
      };
      user_roles: {
        Row: {
          created_at: string;
          id: string;
          role: Database["public"]["Enums"]["app_role"];
          user_id: string;
        };
        Insert: {
          created_at?: string;
          id?: string;
          role: Database["public"]["Enums"]["app_role"];
          user_id: string;
        };
        Update: {
          created_at?: string;
          id?: string;
          role?: Database["public"]["Enums"]["app_role"];
          user_id?: string;
        };
        Relationships: [];
      };
    };
    Views: {
      [_ in never]: never;
    };
    Functions: {
      add_operator_customer_info: {
        Args: { _content: string; _conversation_id: string };
        Returns: {
          client_id: string;
          content: string;
          conversation_id: string | null;
          created_at: string;
          created_by_user_id: string;
          id: string;
          metadata: Json;
          operator_id: string;
          updated_at: string;
        };
        SetofOptions: {
          from: "*";
          to: "customer_info_entries";
          isOneToOne: true;
          isSetofReturn: false;
        };
      };
      add_operator_internal_note: {
        Args: { _conversation_id: string; _note: string };
        Returns: {
          conversation_id: string;
          created_at: string;
          id: string;
          note: string;
          operator_id: string | null;
        };
        SetofOptions: {
          from: "*";
          to: "internal_notes";
          isOneToOne: true;
          isSetofReturn: false;
        };
      };
      can_read_current_conversation: {
        Args: { _conversation_id: string };
        Returns: boolean;
      };
      admin_approve_restore_recovery: {
        Args: { _event_id: string; _expected_version: number; _reason: string };
        Returns: number;
      };
      admin_verify_restore_personal_data: {
        Args: {
          _event_id: string;
          _evidence_hash: string;
          _evidence_source: string;
          _expected_version: number;
          _reason: string;
        };
        Returns: number;
      };
      add_support_ticket_message: {
        Args: { _body: string; _idempotency_key: string; _ticket_id: string };
        Returns: { created_at: string; id: string }[];
      };
      admin_add_support_ticket_message: {
        Args: { _body: string; _idempotency_key: string; _ticket_id: string; _visibility: string };
        Returns: { created_at: string; id: string }[];
      };
      admin_create_support_incident: {
        Args: {
          _details: string;
          _idempotency_key: string;
          _incident_type: string;
          _owner_admin_id: string | null;
          _severity: string;
          _ticket_ids: string[];
          _title: string;
        };
        Returns: { escalation_status: string; id: string; status: string; version: number }[];
      };
      admin_record_support_incident_delivery: {
        Args: {
          _delivery_status: string;
          _expected_version: number;
          _failure_code?: string | null;
          _incident_id: string;
        };
        Returns: { escalation_status: string; id: string; version: number }[];
      };
      admin_set_support_operations_config: {
        Args: {
          _business_owner_admin_id: string | null;
          _deputy_admin_id: string | null;
          _escalation_channel: string;
          _expected_version: number;
          _public_support_contact: string;
          _support_hours: string;
          _technical_contact: string;
        };
        Returns: number;
      };
      admin_set_support_operations_config_v2: {
        Args: {
          _business_owner_admin_id: string | null;
          _deputy_admin_id: string | null;
          _escalation_channel: string;
          _expected_version: number;
          _public_support_contact: string;
          _support_day_end: string | null;
          _support_day_start: string | null;
          _support_timezone: string | null;
          _support_weekdays: number[] | null;
          _technical_contact: string;
        };
        Returns: number;
      };
      admin_set_support_operations_config_v3: {
        Args: {
          _business_owner_admin_id: string | null;
          _deputy_admin_id: string | null;
          _escalation_channel: string;
          _expected_version: number;
          _public_support_contact: string;
          _support_closure_dates: string[] | null;
          _support_timezone: string | null;
          _support_windows: Json | null;
          _technical_contact: string;
        };
        Returns: number;
      };
      admin_update_support_incident: {
        Args: {
          _action?: string | null;
          _expected_version: number;
          _incident_id: string;
          _owner_admin_id: string | null;
          _status: string;
        };
        Returns: {
          acknowledged_at: string | null;
          id: string;
          resolved_at: string | null;
          status: string;
          version: number;
        }[];
      };
      admin_update_support_ticket: {
        Args: {
          _assignee_admin_id: string | null;
          _expected_version: number;
          _status: string;
          _ticket_id: string;
        };
        Returns: {
          assignee_admin_id: string | null;
          id: string;
          status: string;
          updated_at: string;
          version: number;
        }[];
      };
      accept_client_consent: {
        Args: { _document_id: string };
        Returns: { accepted_at: string; document_id: string }[];
      };
      acquire_conversation_lock: {
        Args: { _conversation_id: string };
        Returns: Json;
      };
      create_support_ticket: {
        Args: {
          _category: string;
          _description: string;
          _idempotency_key: string;
          _subject: string;
        };
        Returns: { created_at: string; id: string; status: string }[];
      };
      get_public_support_contact: { Args: never; Returns: string | null };
      get_restore_recovery_access_state: {
        Args: never;
        Returns: {
          blocked: boolean;
          event_id: string | null;
          event_version: number | null;
          status: string | null;
        }[];
      };
      get_admin_restore_recovery_state: {
        Args: never;
        Returns: {
          approved_at: string | null;
          approved_by: string | null;
          event_id: string;
          event_version: number;
          evidence_recorded_at: string | null;
          evidence_source: string | null;
          external_authority_id: string;
          external_lock_id: string;
          owner_admin_id: string;
          reason_code: string | null;
          reopened_at: string | null;
          requirement_name: string | null;
          requirement_status: string | null;
          source_snapshot_at: string;
          source_snapshot_id: string;
          status: string;
        }[];
      };
      get_support_operations_config: {
        Args: never;
        Returns: {
          business_owner_admin_id: string | null;
          deputy_admin_id: string | null;
          escalation_channel: string | null;
          public_support_contact: string | null;
          support_hours: string | null;
          technical_contact: string | null;
          version: number;
        }[];
      };
      get_support_operations_config_v2: {
        Args: never;
        Returns: {
          business_owner_admin_id: string | null;
          deputy_admin_id: string | null;
          escalation_adapter_state: string;
          escalation_channel: string | null;
          public_support_contact: string | null;
          schedule_state: string;
          support_day_end: string | null;
          support_day_start: string | null;
          support_timezone: string | null;
          support_weekdays: number[] | null;
          technical_contact: string | null;
          version: number;
        }[];
      };
      get_support_operations_config_v3: {
        Args: never;
        Returns: {
          business_owner_admin_id: string | null;
          deputy_admin_id: string | null;
          escalation_adapter_state: string;
          escalation_channel: string | null;
          public_support_contact: string | null;
          schedule_state: string;
          support_closure_dates: string[];
          support_schedule_version: number;
          support_timezone: string | null;
          support_windows: Json | null;
          technical_contact: string | null;
          version: number;
        }[];
      };
      adjust_operator_credits: {
        Args: { _amount: number; _operator_id: string; _reason: string };
        Returns: Json;
      };
      admin_add_conversation_note: {
        Args: { _conversation_id: string; _note: string };
        Returns: string;
      };
      admin_add_customer_info_entry: {
        Args: { _content: string; _conversation_id: string };
        Returns: string;
      };
      admin_adjust_client_credits: {
        Args: { _amount: number; _reason: string; _user_id: string };
        Returns: Json;
      };
      admin_adjust_operator_points: {
        Args: { _amount: number; _operator_id: string; _reason: string };
        Returns: Json;
      };
      admin_reassign_conversation: {
        Args: { _conversation_id: string; _operator_id: string; _reason: string };
        Returns: Json;
      };
      admin_set_conversation_status: {
        Args: {
          _conversation_id: string;
          _status: Database["public"]["Enums"]["conversation_status"];
        };
        Returns: Json;
      };
      admin_set_registration_state: {
        Args: { _allow: boolean; _reason: string };
        Returns: Json;
      };
      admin_update_report_status: {
        Args: {
          _report_id: string;
          _status: Database["public"]["Enums"]["report_status"];
        };
        Returns: Json;
      };
      admin_backfill_client_levels: {
        Args: { _after_message_id?: string; _limit?: number };
        Returns: {
          has_more: boolean;
          next_message_id: string | null;
          scanned: number;
        }[];
      };
      archive_client_pii: {
        Args: { _client_id: string; _confirm: string; _reason: string };
        Returns: Json;
      };
      assign_admin_media_asset_tag: {
        Args: { _asset_id: string; _media_tag_id: string };
        Returns: Json;
      };
      begin_character_media_hard_delete_for_server: {
        Args: { _actor_user_id: string; _asset_id: string };
        Returns: {
          asset_id: string;
          bucket_id: string;
          locked_delivery_path: string;
          locked_teaser_path: string;
          preview_path: string;
          source_path: string;
        }[];
      };
      create_registration_admission_for_server: {
        Args: {
          _age_confirmed: boolean;
          _email: string;
          _terms_accepted: boolean;
        };
        Returns: Json;
      };
      begin_character_media_processing_for_server: {
        Args: { _actor_user_id: string; _asset_id: string };
        Returns: {
          already_ready: boolean;
          asset_id: string;
          content_type: string;
          preview_path: string;
          source_path: string;
        }[];
      };
      begin_locked_media_derivative_processing_for_server: {
        Args: { _actor_user_id: string; _asset_id: string };
        Returns: {
          already_ready: boolean;
          asset_id: string;
          content_type: string;
          locked_delivery_path: string;
          locked_teaser_path: string;
          source_path: string;
        }[];
      };
      begin_sticker_hard_delete_for_server: {
        Args: { _actor_user_id: string; _sticker_id: string };
        Returns: {
          object_path: string;
          source_paths: string[];
          sticker_id: string;
        }[];
      };
      begin_sticker_processing_for_server: {
        Args: { _actor_user_id: string; _sticker_id: string };
        Returns: {
          already_ready: boolean;
          object_path: string;
          sticker_id: string;
        }[];
      };
      block_client_for_operator: {
        Args: {
          _client_id: string;
          _conversation_id?: string;
          _notes?: string;
          _reason: string;
          _source?: string;
        };
        Returns: Json;
      };
      claim_new_conversation: { Args: { _work_item_id: string }; Returns: Json };
      claim_client_media_finalize_for_server: {
        Args: { _actor_user_id: string; _upload_id: string };
        Returns: {
          bucket_id: string;
          claim_token: string | null;
          content_type: string;
          preview_path: string | null;
          source_path: string;
          status: string;
          upload_id: string;
        }[];
      };
      claim_expired_client_media_cleanup_for_server: {
        Args: { _limit?: number };
        Returns: {
          bucket_id: string;
          claim_token: string;
          preview_path: string | null;
          source_path: string;
          upload_id: string;
        }[];
      };
      claim_client_profile_image_cleanup_for_server: {
        Args: { _limit?: number };
        Returns: {
          bucket_id: string;
          claim_token: string;
          object_path: string;
          owner_user_id: string;
          queue_id: string;
        }[];
      };
      authorize_client_profile_image_cleanup_for_server: {
        Args: { _claim_token: string; _queue_id: string };
        Returns: string;
      };
      complete_client_media_cleanup_for_server: {
        Args: { _claim_token: string; _upload_id: string };
        Returns: undefined;
      };
      complete_client_profile_image_cleanup_for_server: {
        Args: { _claim_token: string; _queue_id: string };
        Returns: string;
      };
      fail_client_media_cleanup_for_server: {
        Args: { _claim_token: string; _error_code: string; _upload_id: string };
        Returns: undefined;
      };
      fail_client_profile_image_cleanup_for_server: {
        Args: { _claim_token: string; _error_code: string; _queue_id: string };
        Returns: undefined;
      };
      fail_client_media_finalize_for_server: {
        Args: { _claim_token: string; _error_code: string; _upload_id: string };
        Returns: undefined;
      };
      finalize_client_media_upload_for_server: {
        Args: {
          _actor_user_id: string;
          _byte_size: number;
          _content_type: string;
          _finalize_claim_token?: string | null;
          _idempotency_key: string;
          _upload_id: string;
        };
        Returns: Json;
      };
      mark_client_media_finalize_artifact_for_cleanup_for_server: {
        Args: { _claim_token: string; _error_code: string; _upload_id: string };
        Returns: undefined;
      };
      renew_client_media_finalize_claim_for_server: {
        Args: { _claim_token: string; _upload_id: string };
        Returns: boolean;
      };
      get_media_cleanup_backlog_for_server: { Args: never; Returns: Json };
      cleanup_expired_conversation_locks: { Args: never; Returns: number };
      complete_client_onboarding: { Args: { _payload: Json }; Returns: Json };
      create_credit_request: {
        Args: { _idempotency_key: string; _package_id: string };
        Returns: {
          credits: number;
          id: string;
          package_id: string;
          package_name: string;
          requested_at: string;
          status: string;
        }[];
      };
      complete_free_view_once_attachment: {
        Args: { _attachment_id: string };
        Returns: Json;
      };
      complete_paid_message_attachment_session: {
        Args: { _session_id: string };
        Returns: Json;
      };
      complete_sticker_hard_delete_for_server: {
        Args: { _actor_user_id: string; _sticker_id: string };
        Returns: undefined;
      };
      complete_sticker_processing_for_server: {
        Args: {
          _actor_user_id: string;
          _byte_size: number;
          _height: number;
          _sticker_id: string;
          _width: number;
        };
        Returns: {
          already_ready: boolean;
          ingest_status: string;
          sticker_id: string;
        }[];
      };
      configure_character_media_asset_locked: {
        Args: { _asset_id: string; _price_credits?: number };
        Returns: Json;
      };
      configure_character_media_asset_paid_open: {
        Args: { _asset_id: string; _price_credits?: number };
        Returns: Json;
      };
      create_admin_media_tag: {
        Args: { _character_id: string; _name: string; _sort_order?: number };
        Returns: Json;
      };
      create_character_media_upload_intent_for_server: {
        Args: {
          _actor_user_id: string;
          _character_id: string;
          _content_type: string;
          _display_name?: string;
        };
        Returns: {
          asset_id: string;
          content_type: string;
          source_path: string;
        }[];
      };
      create_discovery_city: {
        Args: { _display_name_he: string };
        Returns: {
          display_name_he: string;
          id: string;
        }[];
      };
      create_notification: {
        Args: {
          _body?: string;
          _conversation_id?: string;
          _dedupe_window_seconds?: number;
          _link?: string;
          _metadata?: Json;
          _title: string;
          _type: string;
          _user_id: string;
        };
        Returns: string;
      };
      create_sticker_upload_intent_for_server: {
        Args: {
          _actor_user_id: string;
          _character_id: string;
          _collection_name: string;
          _collection_slug: string;
          _source_content_type?: string;
          _sticker_name: string;
          _sticker_slug: string;
        };
        Returns: {
          object_path: string;
          sticker_id: string;
        }[];
      };
      delete_admin_media_tag: { Args: { _tag_id: string }; Returns: Json };
      disable_character_media_asset: {
        Args: { _asset_id: string; _reason?: string };
        Returns: Json;
      };
      emit_new_sla_critical_notifications: { Args: never; Returns: number };
      fail_character_media_ingest_for_server: {
        Args: { _actor_user_id: string; _asset_id: string; _error_code: string };
        Returns: Json;
      };
      fail_locked_media_derivative_processing_for_server: {
        Args: { _actor_user_id: string; _asset_id: string; _error_code: string };
        Returns: Json;
      };
      fail_sticker_processing_for_server: {
        Args: {
          _actor_user_id: string;
          _failure_code: string;
          _sticker_id: string;
        };
        Returns: undefined;
      };
      finalize_character_media_hard_delete_for_server: {
        Args: { _actor_user_id: string; _asset_id: string };
        Returns: Json;
      };
      finalize_character_media_ingest_for_server: {
        Args: {
          _actor_user_id: string;
          _asset_id: string;
          _byte_size: number;
          _height: number;
          _sha256: string;
          _width: number;
        };
        Returns: Json;
      };
      finalize_locked_media_derivatives_for_server: {
        Args: {
          _actor_user_id: string;
          _asset_id: string;
          _locked_delivery_path: string;
          _locked_teaser_path: string;
        };
        Returns: Json;
      };
      get_admin_character_media_assets: {
        Args: { _character_id: string };
        Returns: {
          byte_size: number;
          content_type: string;
          created_at: string;
          disabled_at: string;
          disabled_reason: string;
          display_name: string;
          height: number;
          id: string;
          ingest_status: string;
          is_global: boolean;
          locked_derivative_error_code: string;
          locked_derivative_status: string;
          locked_derivatives_generated_at: string;
          locked_preview_available: boolean;
          locked_price_credits: number;
          media_tag_id: string;
          media_tag_name: string;
          media_tags: Json;
          character_ids: string[];
          paid_open_price_credits: number;
          preview_available: boolean;
          processing_attempts: number;
          processing_error_code: string;
          processing_started_at: string;
          status: string;
          updated_at: string;
          width: number;
        }[];
      };
      get_admin_advanced_analytics_for_server: {
        Args: { _end_date: string; _start_date: string };
        Returns: Json;
      };
      get_admin_dashboard_analytics_for_server: {
        Args: { _day_keys: string[]; _month_start: string; _since: string };
        Returns: Json;
      };
      get_admin_media_catalog: {
        Args: { _conversation_id: string };
        Returns: {
          byte_size: number;
          content_type: string;
          display_name: string;
          height: number;
          id: string;
          ingest_status: string;
          is_global: boolean;
          is_locked_reservable: boolean;
          is_reservable: boolean;
          is_reserved_by_me: boolean;
          locked_derivative_status: string;
          locked_images_enabled: boolean;
          locked_price_credits: number;
          my_reservation_access_mode: string;
          my_reservation_expires_at: string;
          my_reservation_id: string;
          media_tag_id: string;
          media_tag_name: string;
          media_tags: Json;
          character_ids: string[];
          paid_open_price_credits: number;
          status: string;
          width: number;
        }[];
      };
      get_admin_media_tags: {
        Args: { _character_id: string };
        Returns: {
          asset_count: number;
          created_at: string;
          id: string;
          is_default: boolean;
          name: string;
          sort_order: number;
          updated_at: string;
        }[];
      };
      get_admin_new_queue_overview: {
        Args: never;
        Returns: {
          character_id: string;
          character_name: string;
          new_queue_count: number;
          returned_to_queue_count: number;
          waiting_long_count: number;
        }[];
      };
      get_admin_new_sla_summary: {
        Args: never;
        Returns: {
          character_id: string;
          character_name: string;
          critical_count: number;
          eligible_operator_count: number;
          oldest_wait_seconds: number;
          total_new: number;
          warning_count: number;
        }[];
      };
      get_admin_operations_snapshot: {
        Args: never;
        Returns: {
          active_handling_cycle_count: number;
          active_media_reservation_count: number;
          active_media_tag_count: number;
          active_operator_client_block_count: number;
          active_operator_count: number;
          activity_window_started_at: string;
          archived_client_count: number;
          generated_at: string;
          media_asset_available_count: number;
          media_asset_disabled_count: number;
          media_asset_reserved_count: number;
          media_asset_restored_count: number;
          media_asset_sent_count: number;
          media_asset_total: number;
          new_critical_count: number;
          new_normal_count: number;
          new_oldest_wait_seconds: number;
          new_returned_count: number;
          new_total: number;
          new_warning_count: number;
          offline_operator_count: number;
          online_operator_count: number;
          open_client_report_count: number;
          open_operator_report_count: number;
          outreach_replied_count: number;
          outreach_sent_count: number;
        }[];
      };
      get_admin_operational_wait_summary: {
        Args: never;
        Returns: {
          oldest_wait_seconds: number;
          over_target_count: number;
          target_seconds: number;
          waiting_count: number;
        }[];
      };
      get_admin_completion_exceptions: {
        Args: never;
        Returns: {
          account_deletion_blocked_count: number;
          account_deletion_failure_count: number;
          allocation_issue_count: number;
          conversation_deletion_blocked_count: number;
          conversation_deletion_failure_count: number;
          gift_reward_failure_count: number;
          gift_unallocated_event_count: number;
          media_cleanup_failure_count: number;
        }[];
      };
      get_admin_operator_client_reports: {
        Args: never;
        Returns: {
          client_display_name: string;
          client_id: string;
          conversation_id: string;
          created_at: string;
          id: string;
          notes: string;
          operator_id: string;
          operator_name: string;
          reason: string;
          source: string;
        }[];
      };
      get_admin_operator_presence_overview: {
        Args: never;
        Returns: {
          active_work_item_count: number;
          eligible_new_queue_count: number;
          held_conversations: Json;
          last_seen_at: string;
          operator_id: string;
          presence_status: string;
          stale_returned_count: number;
        }[];
      };
      get_admin_gift_statuses: {
        Args: never;
        Returns: { is_gift: boolean; sticker_id: string }[];
      };
      get_admin_sticker_catalog: {
        Args: never;
        Returns: {
          byte_size: number;
          character_id: string;
          collection_id: string;
          collection_is_active: boolean;
          collection_name: string;
          collection_slug: string;
          created_at: string;
          deletion_started_at: string;
          failure_code: string;
          height: number;
          id: string;
          ingest_status: string;
          is_active: boolean;
          is_processing_stuck: boolean;
          name: string;
          price_credits: number;
          processing_started_at: string;
          slug: string;
          updated_at: string;
          width: number;
        }[];
      };
      get_character_profile: {
        Args: { _character_id: string };
        Returns: {
          availability_status: Database["public"]["Enums"]["availability_status"];
          avatar_url: string;
          category: string;
          city_name: string;
          conversation_id: string;
          fictional_age: number;
          full_description: string;
          gallery_images: string[];
          id: string;
          interests: string[];
          is_favorite: boolean;
          name: string;
          personality: string;
          short_description: string;
        }[];
      };
      get_character_live_availability: {
        Args: { _character_ids: string[] };
        Returns: {
          availability_status: Database["public"]["Enums"]["availability_status"];
          character_id: string;
        }[];
      };
      get_client_consent_requirements: {
        Args: never;
        Returns: {
          accepted_at: string | null;
          consent_key: string;
          document_url: string;
          id: string;
          required: boolean;
          title: string;
          version: string;
        }[];
      };
      get_conversation_read_summary: {
        Args: { _conversation_id: string };
        Returns: Json;
      };
      get_conversation_stickers: {
        Args: { _conversation_id: string };
        Returns: {
          collection_id: string;
          collection_name: string;
          name: string;
          price_credits: number;
          scope: string;
          sort_order: number;
          sticker_id: string;
        }[];
      };
      get_conversation_presence: {
        Args: { _conversation_id: string };
        Returns: {
          display_name: string;
          is_typing: boolean;
          online_at: string;
          role: string;
          user_id: string;
        }[];
      };
      get_conversation_read_access: {
        Args: { _conversation_id: string };
        Returns: {
          access_version: number;
          allowed: boolean;
        }[];
      };
      get_discovery_characters: {
        Args: { _filters?: Json };
        Returns: {
          availability_status: Database["public"]["Enums"]["availability_status"];
          avatar_url: string;
          category: string;
          conversation_id: string;
          created_at: string;
          cycle_id: string;
          cycle_number: number;
          fictional_age: number;
          id: string;
          interests: string[];
          is_favorite: boolean;
          is_liked: boolean;
          is_recycled: boolean;
          name: string;
          short_description: string;
        }[];
      };
      get_character_leads: {
        Args: { _limit?: number };
        Returns: {
          character_id: string;
          character_name: string;
          client_id: string;
          client_name: string;
          created_at: string;
          id: string;
          last_liked_at: string;
          source: string;
        }[];
      };
      get_discovery_characters_base: {
        Args: { _filters?: Json };
        Returns: {
          availability_status: Database["public"]["Enums"]["availability_status"];
          avatar_url: string;
          category: string;
          conversation_id: string;
          created_at: string;
          cycle_id: string;
          cycle_number: number;
          fictional_age: number;
          id: string;
          interests: string[];
          is_favorite: boolean;
          is_liked: boolean;
          is_recycled: boolean;
          name: string;
          short_description: string;
        }[];
      };
      get_message_attachment_access: {
        Args: { _attachment_ids: string[] };
        Returns: {
          access_mode: string;
          available_purchase_id: string | null;
          attachment_id: string;
          is_unlocked: boolean;
          price_credits_snapshot: number;
          render_state: string;
          required_gift_id: string | null;
          required_gift_name: string | null;
          required_gift_price_credits: number | null;
          session_expires_at: string;
          view_mode: string;
        }[];
      };
      get_message_attachment_access_before_wp01_5: {
        Args: { _attachment_ids: string[] };
        Returns: {
          access_mode: string;
          attachment_id: string;
          is_unlocked: boolean;
          price_credits_snapshot: number;
          render_state: string;
          session_expires_at: string;
          view_mode: string;
        }[];
      };
      get_message_attachment_view_url_ttl_for_server: {
        Args: { _actor_user_id: string; _attachment_id: string };
        Returns: number;
      };
      get_my_conversation_unread_counts: {
        Args: { _conversation_ids: string[] };
        Returns: {
          conversation_id: string;
          last_read_at: string;
          unread_count: number;
        }[];
      };
      get_my_operator_client_block_status: {
        Args: { _client_id: string };
        Returns: Json;
      };
      get_my_operator_id: { Args: never; Returns: string };
      get_my_role: {
        Args: never;
        Returns: Database["public"]["Enums"]["app_role"];
      };
      get_conversation_gifts: {
        Args: { _conversation_id: string };
        Returns: {
          gift_id: string;
          name: string;
          price_credits: number;
        }[];
      };
      get_operator_conversation_client_profile: {
        Args: { _conversation_id: string };
        Returns: {
          age: number;
          conversation_preferences: string;
          interests: string[];
        }[];
      };
      get_operator_conversation_responsibility: {
        Args: { _conversation_id: string };
        Returns: {
          cycle_id: string;
          state: string;
        }[];
      };
      get_operator_media_catalog: {
        Args: { _conversation_id: string };
        Returns: {
          byte_size: number;
          content_type: string;
          display_name: string;
          height: number;
          id: string;
          ingest_status: string;
          is_global: boolean;
          is_locked_reservable: boolean;
          is_reservable: boolean;
          is_reserved_by_me: boolean;
          locked_derivative_status: string;
          locked_images_enabled: boolean;
          locked_price_credits: number;
          media_tag_id: string;
          media_tag_name: string;
          media_tags: Json;
          character_ids: string[];
          my_reservation_access_mode: string;
          my_reservation_expires_at: string;
          my_reservation_id: string;
          paid_open_price_credits: number;
          status: string;
          width: number;
        }[];
      };
      get_operator_new_queue: {
        Args: never;
        Returns: {
          character_avatar_url: string;
          character_id: string;
          character_name: string;
          client_display_name: string;
          conversation_id: string;
          created_at: string;
          last_activity_at: string;
          last_client_preview: string;
          queue_state: string;
          sla_state: string;
          status: string;
          wait_seconds: number;
          work_item_id: string;
        }[];
      };
      get_operator_new_sla_summary: {
        Args: never;
        Returns: {
          critical_count: number;
          oldest_wait_seconds: number;
          total_new: number;
          warning_count: number;
        }[];
      };
      get_operator_online_candidates: {
        Args: { _filters?: Json };
        Returns: {
          avatar_url: string;
          character_options: Json;
          client_id: string;
          display_name: string;
          has_existing_conversation: boolean;
        }[];
      };
      get_sla_risk_conversations: {
        Args: { _limit?: number; _notify?: boolean };
        Returns: {
          character_avatar_url: string;
          character_id: string;
          character_name: string;
          client_display_name: string;
          client_id: string;
          conversation_id: string;
          last_client_message_at: string;
          last_message_preview: string;
          minutes_waiting: number;
          status: Database["public"]["Enums"]["conversation_status"];
        }[];
      };
      grant_signup_credits: { Args: never; Returns: Json };
      has_current_user_role: {
        Args: { _role: Database["public"]["Enums"]["app_role"] };
        Returns: boolean;
      };
      has_role: {
        Args: {
          _role: Database["public"]["Enums"]["app_role"];
          _user_id: string;
        };
        Returns: boolean;
      };
      hide_conversation_for_client: {
        Args: { _conversation_id: string };
        Returns: undefined;
      };
      is_admin: { Args: never; Returns: boolean };
      is_conversation_client: {
        Args: { _conversation_id: string };
        Returns: boolean;
      };
      is_conversation_operator: {
        Args: { _conversation_id: string };
        Returns: boolean;
      };
      is_operator: { Args: never; Returns: boolean };
      is_operator_co_assigned: {
        Args: { _operator_id: string };
        Returns: boolean;
      };
      leave_active_conversation: {
        Args: { _conversation_id: string };
        Returns: undefined;
      };
      mark_conversation_read: {
        Args: { _as: string; _conversation_id: string };
        Returns: undefined;
      };
      open_free_view_once_attachment: {
        Args: { _attachment_id: string; _idempotency_key?: string };
        Returns: Json;
      };
      open_paid_message_attachment: {
        Args: { _attachment_id: string; _idempotency_key: string };
        Returns: Json;
      };
      open_attachment_gift_purchase: {
        Args: { _attachment_id: string; _idempotency_key: string; _purchase_id: string };
        Returns: Json;
      };
      operator_can_access_character: {
        Args: { _character_id: string };
        Returns: boolean;
      };
      operator_heartbeat: { Args: never; Returns: Json };
      release_admin_character_media_reservation: {
        Args: { _reservation_id: string };
        Returns: Json;
      };
      release_character_media_reservation: {
        Args: { _reservation_id: string };
        Returns: Json;
      };
      release_conversation_lock: {
        Args: { _conversation_id: string };
        Returns: Json;
      };
      release_operator_conversation: {
        Args: { _conversation_id: string; _reason?: string };
        Returns: Json;
      };
      request_account_deletion: {
        Args: { _idempotency_key: string };
        Returns: { id: string; requested_at: string; status: string }[];
      };
      get_my_account_deletion_status: {
        Args: never;
        Returns: {
          active_system_completed_at: string | null;
          cancellation_deadline: string | null;
          confirmed_at: string | null;
          content_deletion_due_at: string | null;
          failure_code: string | null;
          id: string;
          requested_at: string;
          status: string;
        }[];
      };
      cancel_account_deletion: {
        Args: { _request_id: string };
        Returns: { cancelled_at: string; id: string; status: string }[];
      };
      execute_account_retention_minimization_for_server: {
        Args: { _claim_token: string; _request_id: string };
        Returns: Json;
      };
      block_account_retention_minimization_for_server: {
        Args: { _claim_token: string; _evidence: Json; _request_id: string };
        Returns: undefined;
      };
      request_conversation_deletion: {
        Args: {
          _confirmed?: boolean;
          _conversation_id: string;
          _idempotency_key: string;
          _reason: string;
        };
        Returns: { id: string; requested_at: string; status: string }[];
      };
      resolve_credit_request: {
        Args: { _decision: string; _note?: string; _request_id: string };
        Returns: {
          balance_after: number | null;
          id: string;
          resolved_at: string;
          status: string;
          transaction_id: string | null;
        }[];
      };
      report_client_as_operator: {
        Args: {
          _client_id: string;
          _conversation_id?: string;
          _notes?: string;
          _reason: string;
          _source?: string;
        };
        Returns: Json;
      };
      reserve_admin_character_media_asset: {
        Args: { _asset_id: string; _conversation_id: string };
        Returns: Json;
      };
      reserve_character_media_asset: {
        Args: { _asset_id: string; _conversation_id: string };
        Returns: Json;
      };
      reserve_character_media_for_delivery: {
        Args: {
          _asset_id: string;
          _conversation_id: string;
          _intended_access_mode: string;
        };
        Returns: Json;
      };
      set_admin_media_asset_assignments: {
        Args: {
          _asset_id: string;
          _character_ids: string[];
          _is_global?: boolean;
          _media_tag_ids: string[];
        };
        Returns: Json;
      };
      resolve_admin_sticker_object_path_for_server: {
        Args: { _actor_user_id: string; _sticker_id: string };
        Returns: string;
      };
      resolve_character_media_preview_path_for_server: {
        Args: {
          _actor_user_id: string;
          _target_id: string;
          _target_kind: string;
        };
        Returns: string;
      };
      resolve_character_media_preview_path_before_wp01_5: {
        Args: {
          _actor_user_id: string;
          _target_id: string;
          _target_kind: string;
        };
        Returns: string;
      };
      resolve_conversation_sticker_object_path_for_server: {
        Args: {
          _actor_user_id: string;
          _conversation_id: string;
          _sticker_id: string;
        };
        Returns: string;
      };
      resolve_conversation_sticker_object_path_before_wp01_5: {
        Args: {
          _actor_user_id: string;
          _conversation_id: string;
          _sticker_id: string;
        };
        Returns: string;
      };
      resolve_sticker_object_path_for_server: {
        Args: { _actor_user_id: string; _message_sticker_id: string };
        Returns: string;
      };
      resolve_sticker_object_path_before_wp01_5: {
        Args: { _actor_user_id: string; _message_sticker_id: string };
        Returns: string;
      };
      restore_character_media_asset: {
        Args: { _asset_id: string };
        Returns: Json;
      };
      run_handling_allocation: {
        Args: { _max_assignments?: number };
        Returns: Json;
      };
      return_stale_work_items_to_new: { Args: never; Returns: number };
      save_client_onboarding_step: { Args: { _payload: Json }; Returns: Json };
      send_admin_media_message: {
        Args: { _caption?: string; _reservation_id: string };
        Returns: Json;
      };
      send_admin_sticker_message: {
        Args: {
          _conversation_id: string;
          _idempotency_key: string;
          _sticker_id: string;
        };
        Returns: Json;
      };
      send_client_message: {
        Args: { _content: string; _conversation_id: string };
        Returns: Json;
      };
      send_client_sticker_message: {
        Args: {
          _conversation_id: string;
          _idempotency_key: string;
          _sticker_id: string;
        };
        Returns: Json;
      };
      send_operator_locked_media_message:
        | {
            Args: { _caption?: string; _reservation_id: string };
            Returns: Json;
          }
        | {
            Args: {
              _caption: string;
              _expected_cycle_id: string;
              _reservation_id: string;
            };
            Returns: Json;
          };
      send_operator_gift_media_message:
        | {
            Args: { _caption?: string; _gift_id: string; _reservation_id: string };
            Returns: Json;
          }
        | {
            Args: {
              _caption: string;
              _expected_cycle_id: string;
              _gift_id: string;
              _reservation_id: string;
            };
            Returns: Json;
          };
      send_operator_media_message:
        | {
            Args: {
              _caption?: string;
              _reservation_id: string;
              _view_mode?: string;
            };
            Returns: Json;
          }
        | {
            Args: {
              _caption: string;
              _expected_cycle_id: string;
              _reservation_id: string;
              _view_mode: string;
            };
            Returns: Json;
          };
      send_operator_message:
        | {
            Args: { _content: string; _conversation_id: string };
            Returns: Json;
          }
        | {
            Args: {
              _content: string;
              _conversation_id: string;
              _expected_cycle_id: string;
            };
            Returns: Json;
          };
      send_operator_sticker_message:
        | {
            Args: {
              _conversation_id: string;
              _idempotency_key: string;
              _sticker_id: string;
            };
            Returns: Json;
          }
        | {
            Args: {
              _conversation_id: string;
              _expected_cycle_id: string;
              _idempotency_key: string;
              _sticker_id: string;
            };
            Returns: Json;
          };
      purchase_attachment_gift: {
        Args: { _attachment_id: string; _gift_id: string; _idempotency_key: string };
        Returns: Json;
      };
      remove_character_like: {
        Args: { _character_id: string; _expected_subject: string };
        Returns: Json;
      };
      set_character_favorite: {
        Args: { _character_id: string; _is_favorite: boolean };
        Returns: Json;
      };
      set_character_swipe: {
        Args: {
          _character_id: string;
          _cycle_id: string;
          _filters: Json;
          _swipe: string;
        };
        Returns: Json;
      };
      set_sticker_active: {
        Args: { _is_active: boolean; _sticker_id: string };
        Returns: undefined;
      };
      set_conversation_presence: {
        Args: {
          _active: boolean;
          _conversation_id: string;
          _display_name: string;
          _role: string;
          _typing: boolean;
        };
        Returns: undefined;
      };
      set_sticker_gift_status: {
        Args: { _is_gift: boolean; _sticker_id: string };
        Returns: undefined;
      };
      set_sticker_price: {
        Args: { _price_credits: number; _sticker_id: string };
        Returns: undefined;
      };
      start_operator_outreach: {
        Args: {
          _character_id: string;
          _client_id: string;
          _idempotency_key: string;
          _message: string;
        };
        Returns: Json;
      };
      start_or_get_conversation: {
        Args: { _character_id: string };
        Returns: string;
      };
      touch_active_conversation: {
        Args: { _conversation_id: string; _role: string };
        Returns: undefined;
      };
      track_analytics_event: {
        Args: {
          _character_id?: string;
          _conversation_id?: string;
          _dedupe_seconds?: number;
          _event_name: string;
          _metadata?: Json;
          _operator_id?: string;
        };
        Returns: string;
      };
      unblock_client_for_operator: {
        Args: { _client_id: string };
        Returns: Json;
      };
      unlock_locked_message_attachment: {
        Args: { _attachment_id: string; _idempotency_key: string };
        Returns: Json;
      };
      update_admin_media_tag: {
        Args: { _name: string; _sort_order?: number; _tag_id: string };
        Returns: Json;
      };
      update_character_lead_status: {
        Args: { _lead_id: string; _status: string };
        Returns: {
          id: string;
          interest_active: boolean;
          status: string;
          updated_at: string;
        }[];
      };
      update_operator_conversation_status: {
        Args: {
          _conversation_id: string;
          _status: Database["public"]["Enums"]["conversation_status"];
        };
        Returns: {
          assigned_operator_id: string | null;
          character_id: string;
          client_hidden_at: string | null;
          client_id: string;
          client_unread_count: number;
          created_at: string;
          handling_next_sequence: number;
          handling_state_initialized: boolean;
          handling_state_updated_at: string | null;
          id: string;
          inactivity_expires_at: string | null;
          last_business_message_at: string | null;
          last_handling_message_sequence: number | null;
          last_message_at: string | null;
          last_message_preview: string | null;
          needs_handling: boolean | null;
          operator_unread_count: number;
          pending_since: string | null;
          status: Database["public"]["Enums"]["conversation_status"];
          updated_at: string;
        };
        SetofOptions: {
          from: "*";
          to: "conversations";
          isOneToOne: true;
          isSetofReturn: false;
        };
      };
      update_client_profile_images: {
        Args: { _profile_image_url?: string | null; _profile_image_urls: string[] };
        Returns: {
          profile_image_url: string | null;
          profile_image_urls: string[];
        }[];
      };
    };
    Enums: {
      app_role: "client" | "operator" | "admin";
      availability_status: "available" | "busy" | "offline";
      conversation_status: "open" | "waiting" | "answered" | "closed" | "reported";
      report_status: "open" | "reviewed" | "resolved" | "dismissed";
      sender_type: "client" | "operator" | "admin" | "system";
    };
    CompositeTypes: {
      [_ in never]: never;
    };
  };
};

type DatabaseWithoutInternals = Omit<Database, "__InternalSupabase">;

type DefaultSchema = DatabaseWithoutInternals[Extract<keyof Database, "public">];

export type Tables<
  DefaultSchemaTableNameOrOptions extends
    | keyof (DefaultSchema["Tables"] & DefaultSchema["Views"])
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals;
  }
    ? keyof (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
        DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals;
}
  ? (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
      DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])[TableName] extends {
      Row: infer R;
    }
    ? R
    : never
  : DefaultSchemaTableNameOrOptions extends keyof (DefaultSchema["Tables"] & DefaultSchema["Views"])
    ? (DefaultSchema["Tables"] & DefaultSchema["Views"])[DefaultSchemaTableNameOrOptions] extends {
        Row: infer R;
      }
      ? R
      : never
    : never;

export type TablesInsert<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals;
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals;
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Insert: infer I;
    }
    ? I
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Insert: infer I;
      }
      ? I
      : never
    : never;

export type TablesUpdate<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals;
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals;
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Update: infer U;
    }
    ? U
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Update: infer U;
      }
      ? U
      : never
    : never;

export type Enums<
  DefaultSchemaEnumNameOrOptions extends
    | keyof DefaultSchema["Enums"]
    | { schema: keyof DatabaseWithoutInternals },
  EnumName extends DefaultSchemaEnumNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals;
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"]
    : never = never,
> = DefaultSchemaEnumNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals;
}
  ? DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"][EnumName]
  : DefaultSchemaEnumNameOrOptions extends keyof DefaultSchema["Enums"]
    ? DefaultSchema["Enums"][DefaultSchemaEnumNameOrOptions]
    : never;

export type CompositeTypes<
  PublicCompositeTypeNameOrOptions extends
    | keyof DefaultSchema["CompositeTypes"]
    | { schema: keyof DatabaseWithoutInternals },
  CompositeTypeName extends PublicCompositeTypeNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals;
  }
    ? keyof DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"]
    : never = never,
> = PublicCompositeTypeNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals;
}
  ? DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"][CompositeTypeName]
  : PublicCompositeTypeNameOrOptions extends keyof DefaultSchema["CompositeTypes"]
    ? DefaultSchema["CompositeTypes"][PublicCompositeTypeNameOrOptions]
    : never;

export const Constants = {
  graphql_public: {
    Enums: {},
  },
  public: {
    Enums: {
      app_role: ["client", "operator", "admin"],
      availability_status: ["available", "busy", "offline"],
      conversation_status: ["open", "waiting", "answered", "closed", "reported"],
      report_status: ["open", "reviewed", "resolved", "dismissed"],
      sender_type: ["client", "operator", "admin", "system"],
    },
  },
} as const;
